// ── Config ─────────────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.dinero-coin.com';
const DIN_PER_UNA = 100_000_000;
const BLOCKS_PER_PAGE = 10;
const AUTO_REFRESH_MS = 30_000;

// ── RPC client ─────────────────────────────────────────────────────────────────
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // Some dinerod RPCs report errors via the JSON-RPC `error` field, and
  // others wrap the error inside `result` as `{"error": "reason"}`. The
  // latter is how e.g. blockchain.getblock responds to an unknown hash.
  // Without this check the caller would get the error object back and
  // treat it like a normal result, which is how the Latest Blocks table
  // was rendering rows of NaN when LA was stuck (Apr 13 2026).
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  if (body.result && typeof body.result === 'object' && body.result.error) {
    throw new Error(String(body.result.error));
  }
  return body.result;
}

// ── Formatters ──────────────────────────────────────────────────────────────────
function shortHash(h, n = 16) {
  if (!h || h.length <= n * 2 + 3) return h || '—';
  return `${h.slice(0, n)}…${h.slice(-8)}`;
}

function timeAgo(unix) {
  if (!unix) return '—';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toUTCString();
}

function txTypeBadge(tx) {
  if (!tx) return '';
  if (tx.is_coinbase) return `<span class="badge badge-green">Coinbase</span>`;
  const v = tx.version ?? 1;
  if (v === 4) return `<span class="badge badge-teal">Ring-Covenant</span>`;
  if (v === 3 || tx.has_confidential_inputs) return `<span class="badge badge-blue">Ring</span>`;
  if (tx.has_confidential_outputs) return `<span class="badge badge-blue">Private</span>`;
  return `<span class="badge" style="background:rgba(107,114,128,0.15);color:var(--muted)">Standard</span>`;
}

// ── Router ──────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');
let refreshTimer = null;

function clearRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function route() {
  clearRefresh();
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  const page = parts[0] || '';

  if (!page)              return renderHome();
  if (page === 'block')   return renderBlock(parts[1], parts[2]);
  if (page === 'tx')      return renderTx(parts[1]);
  if (page === 'address') return renderAddress(parts[1]);
  renderError('Page not found');
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);

document.getElementById('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  document.getElementById('searchInput').value = '';
  if (/^\d+$/.test(q))            location.hash = `/block/height/${q}`;
  else if (/^[0-9a-fA-F]{64}$/.test(q)) location.hash = `/tx/${q}`;
  else                             location.hash = `/address/${q}`;
});

// ── Helpers ──────────────────────────────────────────────────────────────────────
function loading() {
  app.innerHTML = `<div class="loading"><span class="spinner"></span>Loading…</div>`;
}
function renderError(msg) {
  app.innerHTML = `<div class="container"><div class="error">⚠ ${msg}</div></div>`;
}
function setFooterHeight(h) {
  const el = document.getElementById('footerHeight');
  if (el && h != null) el.textContent = Number(h).toLocaleString();
}

// ── Home ─────────────────────────────────────────────────────────────────────────
async function renderHome() {
  loading();
  try {
    await loadHome();
    refreshTimer = setInterval(async () => {
      if (location.hash.slice(1).replace(/^\//, '') === '') await loadHome(true);
      else clearRefresh();
    }, AUTO_REFRESH_MS);
  } catch (e) {
    renderError('Cannot reach the Dinero node: ' + e.message);
  }
}

async function loadHome(silent = false) {
  const [info, mining] = await Promise.all([
    rpc('blockchain.getblockchaininfo'),
    rpc('blockchain.getmininginfo').catch(() => ({})),
  ]);

  const height = info.blocks ?? 0;
  setFooterHeight(height);

  // Clamp the fetch count so a freshly-reset chain (height = 0, only genesis)
  // doesn't try to fetch negative block heights.
  const rowCount = Math.min(BLOCKS_PER_PAGE, height + 1);
  // Use allSettled so one bad hash/block doesn't blow up the whole table.
  // If the driver node is partially out of sync, prefer to show whatever
  // blocks we can fetch rather than a blank page.
  const hashResults = await Promise.allSettled(
    Array.from({ length: rowCount }, (_, i) => rpc('blockchain.getblockhash', [height - i]))
  );
  const hashes = hashResults.map(r => (r.status === 'fulfilled' ? r.value : null));
  const blockResults = await Promise.allSettled(
    hashes.map(h => (h ? rpc('blockchain.getblock', [h, 1]) : Promise.resolve(null)))
  );
  const blocks = blockResults.map(r => (r.status === 'fulfilled' ? r.value : null));

  if (!silent) {
    app.innerHTML = `<div class="container">${statsBar(info, mining)}${latestBlocksTable(blocks)}</div>`;
  } else {
    // Soft refresh: update stats + table rows only
    const statsEl = app.querySelector('.stats-grid');
    const tableEl = app.querySelector('tbody');
    if (statsEl) statsEl.outerHTML = statsBar(info, mining);
    if (tableEl) tableEl.innerHTML = blocks.map(blockRow).join('');
  }
}

function statsBar(info, mining) {
  const hashrate = mining.networkhashps ?? info.networkhashps ?? null;
  const hr = hashrate != null
    ? hashrate > 1e12 ? `${(hashrate/1e12).toFixed(2)} TH/s`
    : hashrate > 1e9  ? `${(hashrate/1e9).toFixed(2)} GH/s`
    : `${(hashrate/1e6).toFixed(2)} MH/s`
    : '—';

  const supply = info.moneysupply
    ? parseFloat(info.moneysupply).toLocaleString(undefined, {maximumFractionDigits: 0})
    : '—';

  return `<div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Block Height</div>
      <div class="stat-value">${(info.blocks ?? 0).toLocaleString()}</div>
      <div class="stat-sub">${info.chain ?? ''} network</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Difficulty</div>
      <div class="stat-value">${info.difficulty ? Number(info.difficulty).toLocaleString() : '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Hashrate</div>
      <div class="stat-value">${hr}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Money Supply</div>
      <div class="stat-value">${supply}</div>
      <div class="stat-sub">DIN circulating</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Privacy Lane</div>
      <div class="stat-value" style="color:var(--success)">Active</div>
      <div class="stat-sub">Ring-16 · CT</div>
    </div>
  </div>`;
}

function latestBlocksTable(blocks) {
  return `<div class="section-title" style="margin-bottom:12px">Latest Blocks <span class="auto-refresh-badge">↻ auto-refresh</span></div>
  <div class="card">
    <table>
      <thead>
        <tr><th>Height</th><th>Hash</th><th>Time</th><th>Txns</th><th>Nonce</th></tr>
      </thead>
      <tbody>${blocks.map(blockRow).join('')}</tbody>
    </table>
  </div>`;
}

function blockRow(b) {
  // Tolerate null (fetch failed) or an error shape so we render a
  // placeholder row instead of producing `NaN` / blank columns.
  if (!b || typeof b !== 'object' || b.error) {
    return `<tr>
      <td>—</td>
      <td class="hash-short mono">—</td>
      <td style="color:var(--muted)">—</td>
      <td>?</td>
      <td class="mono" style="color:var(--muted);font-size:11px">—</td>
    </tr>`;
  }
  const hash  = b.hash ?? '';
  const h     = b.height;
  const txn   = b.nTx ?? (Array.isArray(b.tx) ? b.tx.length : '?');
  const time  = b.time ?? null;
  const nonce = b.nonce ?? '—';
  // Guard Number() against non-numeric heights so a malformed field
  // doesn't surface as "NaN" in the table.
  const heightStr = (typeof h === 'number' && Number.isFinite(h))
    ? h.toLocaleString()
    : '—';
  return `<tr>
    <td><a href="#/block/${hash}">${heightStr}</a></td>
    <td><a href="#/block/${hash}" class="hash-short mono">${shortHash(hash)}</a></td>
    <td style="color:var(--muted)">${timeAgo(time)}</td>
    <td>${txn}</td>
    <td class="mono" style="color:var(--muted);font-size:11px">${nonce}</td>
  </tr>`;
}

// ── Block detail ──────────────────────────────────────────────────────────────────
async function renderBlock(hashOrKeyword, heightStr) {
  loading();
  try {
    let hash = hashOrKeyword;
    if (hashOrKeyword === 'height' && heightStr) {
      hash = await rpc('blockchain.getblockhash', [parseInt(heightStr)]);
    } else if (/^\d+$/.test(hashOrKeyword)) {
      hash = await rpc('blockchain.getblockhash', [parseInt(hashOrKeyword)]);
    }

    const b = await rpc('blockchain.getblock', [hash, 1]);
    const txids = Array.isArray(b.tx) ? b.tx : [];
    const height = b.height ?? '?';

    setFooterHeight(height);

    // Fetch tx details in parallel (cap at 20 for perf)
    const sample = txids.slice(0, 20);
    const txDetails = await Promise.all(
      sample.map(txid => rpc('gettransaction', [txid]).catch(() => null))
    );

    const prevLink = b.previousblockhash
      ? `<a href="#/block/${b.previousblockhash}" class="hash">${shortHash(b.previousblockhash)}</a>`
      : '<span style="color:var(--muted)">genesis</span>';

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title"><span class="badge badge-blue">Block</span> #${Number(height).toLocaleString()}</div>
        <div class="detail-grid">
          <span class="detail-label">Hash</span>
          <span class="detail-value hash">${b.hash ?? hash}</span>

          <span class="detail-label">Previous</span>
          <span class="detail-value">${prevLink}</span>

          <span class="detail-label">Time</span>
          <span class="detail-value">${fmtDate(b.time)} <span style="color:var(--muted)">(${timeAgo(b.time)})</span></span>

          <span class="detail-label">Transactions</span>
          <span class="detail-value">${txids.length}</span>

          <span class="detail-label">Nonce</span>
          <span class="detail-value mono">${b.nonce ?? '—'}</span>

          <span class="detail-label">Bits</span>
          <span class="detail-value mono">${b.bits != null ? b.bits.toString(16).padStart(8,'0') : '—'}</span>

          <span class="detail-label">Merkle Root</span>
          <span class="detail-value hash" style="font-size:11px">${b.merkleroot ?? '—'}</span>

          <span class="detail-label">Utreexo</span>
          <span class="detail-value hash" style="font-size:11px">${b.utreexocommitment ?? '—'}</span>
        </div>
      </div>

      <div class="section-title">Transactions (${txids.length}${txids.length > 20 ? ', showing first 20' : ''})</div>
      <div class="card">
        <table>
          <thead>
            <tr><th>TXID</th><th>Type</th><th>Inputs</th><th>Outputs</th><th>Total Out</th></tr>
          </thead>
          <tbody>
            ${txDetails.map((tx, i) => txRowBlock(txids[i], tx)).join('')}
            ${txids.slice(20).map(txid => `<tr>
              <td><a href="#/tx/${txid}" class="hash-short mono">${shortHash(txid)}</a></td>
              <td colspan="4" style="color:var(--muted)">—</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    renderError('Block not found: ' + e.message);
  }
}

function txRowBlock(txid, tx) {
  const id = txid ?? tx?.txid ?? '';
  if (!tx) return `<tr>
    <td><a href="#/tx/${id}" class="hash-short mono">${shortHash(id)}</a></td>
    <td colspan="4" style="color:var(--muted)">—</td>
  </tr>`;

  const totalOut = tx.total_output_value_din != null
    ? `${parseFloat(tx.total_output_value_din).toFixed(2)} DIN` : '—';

  return `<tr>
    <td><a href="#/tx/${id}" class="hash-short mono">${shortHash(id)}</a></td>
    <td>${txTypeBadge(tx)}</td>
    <td>${tx.input_count ?? '?'}</td>
    <td>${tx.output_count ?? '?'}</td>
    <td class="mono" style="color:var(--accent2)">${totalOut}</td>
  </tr>`;
}

// ── Transaction detail ─────────────────────────────────────────────────────────
async function renderTx(txid) {
  loading();
  try {
    const tx = await rpc('gettransaction', [txid]);
    if (!tx) throw new Error('not found');

    const inputs  = tx.inputs  ?? [];
    const outputs = tx.outputs ?? [];

    const blockLink = tx.blockhash
      ? `<a href="#/block/${tx.blockhash}" class="hash">${shortHash(tx.blockhash)}</a>`
        + (tx.blockheight != null ? ` <span style="color:var(--muted)">(#${Number(tx.blockheight).toLocaleString()})</span>` : '')
      : '<span style="color:var(--muted)">unconfirmed</span>';

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title">${txTypeBadge(tx)} Transaction</div>
        <div class="detail-grid">
          <span class="detail-label">TXID</span>
          <span class="detail-value hash">${tx.txid ?? txid}</span>

          <span class="detail-label">Block</span>
          <span class="detail-value">${blockLink}</span>

          <span class="detail-label">Confirmations</span>
          <span class="detail-value">${tx.confirmations != null ? Number(tx.confirmations).toLocaleString() : '0'}</span>

          <span class="detail-label">Status</span>
          <span class="detail-value">${tx.status === 'confirmed'
            ? '<span style="color:var(--success)">✓ Confirmed</span>'
            : '<span style="color:var(--muted)">Pending</span>'}</span>

          <span class="detail-label">Version</span>
          <span class="detail-value">${tx.version ?? '—'}</span>

          <span class="detail-label">Type</span>
          <span class="detail-value">${tx.classification ?? '—'}</span>

          <span class="detail-label">Total Output</span>
          <span class="detail-value mono" style="color:var(--accent2)">${tx.total_output_value_din != null
            ? parseFloat(tx.total_output_value_din).toFixed(8) + ' DIN' : '—'}</span>

          ${tx.has_confidential_inputs || tx.has_confidential_outputs ? `
          <span class="detail-label">Privacy</span>
          <span class="detail-value">
            ${tx.has_confidential_inputs ? '<span class="confidential-badge">Private Inputs</span> ' : ''}
            ${tx.has_confidential_outputs ? '<span class="confidential-badge">Private Outputs</span>' : ''}
          </span>` : ''}
        </div>
      </div>

      <div class="two-col">
        <div>
          <div class="section-title">Inputs (${inputs.length})</div>
          <div class="detail-card" style="padding:16px">
            ${inputs.length === 0
              ? '<div style="color:var(--muted)">No inputs</div>'
              : inputs.map(inp => inputRow(inp, tx.is_coinbase)).join('')}
          </div>
        </div>
        <div>
          <div class="section-title">Outputs (${outputs.length})</div>
          <div class="detail-card" style="padding:16px">
            ${outputs.length === 0
              ? '<div style="color:var(--muted)">No outputs</div>'
              : outputs.map(out => outputRow(out)).join('')}
          </div>
        </div>
      </div>
    </div>`;
  } catch (e) {
    renderError('Transaction not found: ' + e.message);
  }
}

function inputRow(inp, isCoinbase) {
  if (isCoinbase) return `<div class="io-row">
    <div><div class="io-label">Coinbase — newly minted coins</div></div>
    <div class="io-amount">New coins</div>
  </div>`;

  if (inp.is_private || inp.ring_size) {
    return `<div class="io-row">
      <div>
        <div class="confidential-badge">Private Input · Ring-${inp.ring_size ?? 16}</div>
        ${inp.key_image ? `<div class="mono" style="font-size:10px;color:var(--muted);margin-top:4px">Key image: ${shortHash(inp.key_image, 12)}</div>` : ''}
      </div>
      <div class="io-amount">hidden</div>
    </div>`;
  }

  const prev = inp.prevout_txid && inp.prevout_txid !== '0'.repeat(64)
    ? `<a href="#/tx/${inp.prevout_txid}" class="mono" style="font-size:11px">${shortHash(inp.prevout_txid)}:${inp.prevout_vout ?? 0}</a>`
    : '';

  return `<div class="io-row">
    <div>
      ${prev || '<span style="color:var(--muted);font-size:11px">unknown</span>'}
    </div>
    <div class="io-amount">—</div>
  </div>`;
}

function outputRow(out) {
  if (out.is_confidential || out.amount_hidden) {
    return `<div class="io-row">
      <div><div class="confidential-badge">Confidential Output</div></div>
      <div class="io-amount">hidden</div>
    </div>`;
  }

  const val  = out.value_din ?? out.display_amount ?? null;
  const type = out.type ?? '';

  // Try to extract address from scriptPubKey (taproot = P2TR)
  const spk  = out.scriptPubKey ?? '';
  let addrDisplay = '';
  if (out.address) {
    addrDisplay = `<a href="#/address/${out.address}" class="mono hash-short" style="font-size:11px">${shortHash(out.address, 22)}</a>`;
  } else if (type === 'legacy' && spk.startsWith('6a')) {
    addrDisplay = `<span style="color:var(--muted);font-size:11px">OP_RETURN</span>`;
  } else if (spk) {
    addrDisplay = `<span class="mono" style="font-size:10px;color:var(--muted)">${shortHash(spk, 14)}</span>`;
  }

  return `<div class="io-row">
    <div>
      ${addrDisplay}
      ${type && type !== 'legacy' ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${type}</div>` : ''}
    </div>
    <div class="io-amount">${val != null ? parseFloat(val).toFixed(8) + ' DIN' : '—'}</div>
  </div>`;
}

// ── Address ───────────────────────────────────────────────────────────────────
async function renderAddress(addr) {
  loading();
  try {
    const [balInfo, history] = await Promise.all([
      rpc('blockchain.getaddressbalance', [addr]).catch(() => null),
      rpc('blockchain.getaddresshistory', [addr]).catch(() => []),
    ]);

    const balance     = balInfo?.balance ?? balInfo?.confirmed ?? balInfo?.total ?? null;
    const unconfirmed = balInfo?.unconfirmed ?? null;
    const txList      = Array.isArray(history) ? history
                      : (history?.txids ?? history?.transactions ?? []);

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title"><span class="badge badge-teal">Address</span></div>
        <div class="mono hash" style="word-break:break-all;margin-bottom:16px;font-size:13px">${addr}</div>
        <div class="balance-display">
          ${balance != null ? parseFloat(balance).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:8}) : '—'}
          <span class="balance-unit">DIN</span>
        </div>
        ${unconfirmed && parseFloat(unconfirmed) !== 0
          ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">+ ${parseFloat(unconfirmed).toFixed(8)} DIN unconfirmed</div>`
          : ''}
      </div>

      <div class="section-title">Transactions (${txList.length})</div>
      <div class="card">
        <table>
          <thead>
            <tr><th>TXID</th><th>Block</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${txList.length === 0
              ? `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:24px">No transactions found</td></tr>`
              : txList.map(t => {
                  const txid   = typeof t === 'string' ? t : (t.txid ?? t.hash ?? '');
                  const height = t.height ?? t.blockheight ?? null;
                  return `<tr>
                    <td><a href="#/tx/${txid}" class="hash-short mono">${shortHash(txid)}</a></td>
                    <td>${height != null
                      ? `<a href="#/block/height/${height}">#${Number(height).toLocaleString()}</a>`
                      : '<span style="color:var(--muted)">unconfirmed</span>'}</td>
                    <td>${height != null
                      ? '<span class="badge badge-green">Confirmed</span>'
                      : '<span style="color:var(--muted)">Pending</span>'}</td>
                  </tr>`;
                }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    renderError('Address lookup failed: ' + e.message);
  }
}
