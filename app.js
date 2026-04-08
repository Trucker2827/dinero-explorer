// ── Config ────────────────────────────────────────────────────────────────────
// Public read-only RPC proxy (nginx on LA server, no auth required from browser)
const RPC_URL = 'https://rpc.dinerocoin.org';

const DIN_PER_UNA = 100_000_000;

// ── RPC client ─────────────────────────────────────────────────────────────────
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

// ── Formatters ─────────────────────────────────────────────────────────────────
function shortHash(h, n = 16) {
  if (!h) return '—';
  return h.length > n * 2 + 3 ? `${h.slice(0, n)}…${h.slice(-8)}` : h;
}

function formatDIN(una) {
  if (una == null) return '—';
  return (una / DIN_PER_UNA).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function timeAgo(unix) {
  if (!unix) return '—';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toUTCString();
}

function fmtSize(bytes) {
  if (bytes == null) return '—';
  return bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

// ── Router ─────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');

function route() {
  const hash = location.hash.slice(1) || '/';
  const [, page, ...rest] = hash.split('/');

  if (!page || page === '') return renderHome();
  if (page === 'block') return renderBlock(rest[0]);
  if (page === 'tx') return renderTx(rest[0]);
  if (page === 'address') return renderAddress(rest[0]);
  renderError('Page not found: ' + hash);
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);

document.getElementById('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  document.getElementById('searchInput').value = '';
  // Height (number), txid (64-char hex), or address
  if (/^\d+$/.test(q)) {
    location.hash = `/block/height/${q}`;
  } else if (/^[0-9a-fA-F]{64}$/.test(q)) {
    location.hash = `/tx/${q}`;
  } else {
    location.hash = `/address/${q}`;
  }
});

// ── Loading / Error ────────────────────────────────────────────────────────────
function loading() {
  app.innerHTML = `<div class="loading"><span class="spinner"></span>Loading…</div>`;
}

function renderError(msg) {
  app.innerHTML = `<div class="container"><div class="error">⚠ ${msg}</div></div>`;
}

// ── Home ───────────────────────────────────────────────────────────────────────
async function renderHome() {
  loading();
  try {
    const [info, mining] = await Promise.all([
      rpc('blockchain.getblockchaininfo'),
      rpc('blockchain.getmininginfo').catch(() => ({})),
    ]);

    const height = info.blocks ?? info.height ?? 0;
    document.getElementById('footerHeight').textContent = height.toLocaleString();

    // Fetch last 10 blocks
    const blockHashes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => rpc('blockchain.getblockhash', [height - i]))
    );
    const blocks = await Promise.all(
      blockHashes.map(h => rpc('blockchain.getblock', [h, 1]))
    );

    app.innerHTML = `<div class="container">
      ${statsBar(info, mining)}
      <div class="section-title">Latest Blocks</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Height</th>
              <th>Hash</th>
              <th>Time</th>
              <th>Txns</th>
              <th>Size</th>
              <th>Miner Reward</th>
            </tr>
          </thead>
          <tbody>
            ${blocks.map(b => blockRow(b)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    renderError('Cannot reach the Dinero node: ' + e.message);
  }
}

function statsBar(info, mining) {
  const supply = info.moneysupply ? parseFloat(info.moneysupply).toLocaleString() : '—';
  const diff = info.difficulty ? Number(info.difficulty).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  const hashrate = mining.networkhashps
    ? `${(mining.networkhashps / 1e9).toFixed(2)} GH/s`
    : (info.networkhashps ? `${(info.networkhashps / 1e9).toFixed(2)} GH/s` : '—');

  return `<div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Block Height</div>
      <div class="stat-value">${(info.blocks ?? 0).toLocaleString()}</div>
      <div class="stat-sub">${info.chain ?? ''} network</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Difficulty</div>
      <div class="stat-value">${diff}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Hashrate</div>
      <div class="stat-value">${hashrate}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Money Supply</div>
      <div class="stat-value">${supply}</div>
      <div class="stat-sub">DIN</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Privacy Lane</div>
      <div class="stat-value" style="color:var(--success)">Active</div>
      <div class="stat-sub">Ring-16 · CT</div>
    </div>
  </div>`;
}

function blockRow(b) {
  if (!b) return '';
  const h = b.height ?? '?';
  const hash = b.hash ?? b.blockhash ?? '';
  const txCount = Array.isArray(b.tx) ? b.tx.length : (b.nTx ?? b.ntx ?? '?');
  const size = b.size ?? b.strippedsize ?? null;
  const time = b.time ?? b.mediantime ?? null;
  const subsidy = b.subsidy ?? null;

  return `<tr>
    <td><a href="#/block/${hash}">${h.toLocaleString()}</a></td>
    <td><a href="#/block/${hash}" class="hash-short mono">${shortHash(hash)}</a></td>
    <td style="color:var(--muted)">${timeAgo(time)}</td>
    <td>${txCount}</td>
    <td style="color:var(--muted)">${fmtSize(size)}</td>
    <td class="mono" style="color:var(--accent2)">${subsidy != null ? formatDIN(subsidy) + ' DIN' : '—'}</td>
  </tr>`;
}

// ── Block ──────────────────────────────────────────────────────────────────────
async function renderBlock(hashOrHeight) {
  loading();
  try {
    // Allow /block/height/N routing
    let hash = hashOrHeight;
    if (/^\d+$/.test(hashOrHeight)) {
      hash = await rpc('blockchain.getblockhash', [parseInt(hashOrHeight)]);
    }

    const b = await rpc('blockchain.getblock', [hash, 2]);
    const height = b.height ?? '?';
    const txs = Array.isArray(b.tx) ? b.tx : [];

    document.getElementById('footerHeight').textContent = (b.confirmations != null && b.height != null)
      ? (b.height + b.confirmations - 1).toLocaleString() : '—';

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title">
          <span class="badge badge-blue">Block</span>
          #${height.toLocaleString()}
        </div>
        <div class="detail-grid">
          <span class="detail-label">Hash</span>
          <span class="detail-value hash">${b.hash ?? hash}</span>

          <span class="detail-label">Previous</span>
          <span class="detail-value">
            ${b.previousblockhash
              ? `<a href="#/block/${b.previousblockhash}" class="hash">${shortHash(b.previousblockhash)}</a>`
              : '<span style="color:var(--muted)">genesis</span>'}
          </span>

          <span class="detail-label">Next</span>
          <span class="detail-value">
            ${b.nextblockhash
              ? `<a href="#/block/${b.nextblockhash}" class="hash">${shortHash(b.nextblockhash)}</a>`
              : '<span style="color:var(--muted)">—</span>'}
          </span>

          <span class="detail-label">Time</span>
          <span class="detail-value">${fmtDate(b.time)}</span>

          <span class="detail-label">Confirmations</span>
          <span class="detail-value">${b.confirmations != null ? b.confirmations.toLocaleString() : '—'}</span>

          <span class="detail-label">Transactions</span>
          <span class="detail-value">${txs.length}</span>

          <span class="detail-label">Size</span>
          <span class="detail-value">${fmtSize(b.size)}</span>

          <span class="detail-label">Difficulty</span>
          <span class="detail-value">${b.difficulty ? Number(b.difficulty).toLocaleString() : '—'}</span>

          <span class="detail-label">Nonce</span>
          <span class="detail-value">${b.nonce ?? '—'}</span>

          <span class="detail-label">Merkle Root</span>
          <span class="detail-value hash" style="font-size:11px">${b.merkleroot ?? '—'}</span>
        </div>
      </div>

      <div class="section-title">Transactions (${txs.length})</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>TXID</th>
              <th>Inputs</th>
              <th>Outputs</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            ${txs.map(tx => txRowFromBlock(tx)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    renderError('Block not found: ' + e.message);
  }
}

function txRowFromBlock(tx) {
  if (!tx) return '';
  const txid = tx.txid ?? tx.hash ?? '';
  const vins = Array.isArray(tx.vin) ? tx.vin.length : '?';
  const vouts = Array.isArray(tx.vout) ? tx.vout.length : '?';
  const isCoinbase = Array.isArray(tx.vin) && tx.vin[0]?.coinbase != null;
  const hasPrivate = Array.isArray(tx.vin) && tx.vin.some(v => v.key_image || v.ring_members);
  const version = tx.version ?? 1;

  let badge = '';
  if (isCoinbase) badge = `<span class="badge badge-green">Coinbase</span>`;
  else if (version === 4) badge = `<span class="badge badge-teal">Ring-Covenant</span>`;
  else if (version === 3) badge = `<span class="badge badge-blue">Ring</span>`;
  else if (hasPrivate) badge = `<span class="badge badge-blue">Private</span>`;

  return `<tr>
    <td><a href="#/tx/${txid}" class="hash-short mono">${shortHash(txid)}</a></td>
    <td>${vins}</td>
    <td>${vouts}</td>
    <td>${badge}</td>
  </tr>`;
}

// ── Transaction ────────────────────────────────────────────────────────────────
async function renderTx(txid) {
  loading();
  try {
    const tx = await rpc('gettransaction', [txid]);
    if (!tx) throw new Error('not found');

    const isCoinbase = Array.isArray(tx.vin) && tx.vin[0]?.coinbase != null;
    const version = tx.version ?? 1;
    const hasPrivate = version >= 3;

    let typeLabel = 'Standard';
    if (isCoinbase) typeLabel = 'Coinbase';
    else if (version === 4) typeLabel = 'Ring-Covenant (v4)';
    else if (version === 3) typeLabel = 'Ring (v3)';

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title">
          <span class="badge badge-blue">Transaction</span>
        </div>
        <div class="detail-grid">
          <span class="detail-label">TXID</span>
          <span class="detail-value hash">${tx.txid ?? txid}</span>

          <span class="detail-label">Block</span>
          <span class="detail-value">
            ${tx.blockhash
              ? `<a href="#/block/${tx.blockhash}" class="hash">${shortHash(tx.blockhash)}</a>`
                + (tx.blockheight != null ? ` <span style="color:var(--muted)">(#${tx.blockheight.toLocaleString()})</span>` : '')
              : '<span style="color:var(--muted)">unconfirmed</span>'}
          </span>

          <span class="detail-label">Confirmations</span>
          <span class="detail-value">${tx.confirmations != null ? tx.confirmations.toLocaleString() : '0'}</span>

          <span class="detail-label">Time</span>
          <span class="detail-value">${tx.blocktime ? fmtDate(tx.blocktime) : (tx.time ? fmtDate(tx.time) : 'unconfirmed')}</span>

          <span class="detail-label">Type</span>
          <span class="detail-value">${typeLabel}</span>

          <span class="detail-label">Version</span>
          <span class="detail-value">${version}</span>

          <span class="detail-label">Size</span>
          <span class="detail-value">${fmtSize(tx.size ?? tx.vsize)}</span>

          ${tx.fee != null ? `
          <span class="detail-label">Fee</span>
          <span class="detail-value" style="color:var(--muted)">${Math.abs(tx.fee).toFixed(8)} DIN</span>
          ` : ''}
        </div>
      </div>

      <div class="two-col">
        <div>
          <div class="section-title">Inputs (${(tx.vin ?? []).length})</div>
          <div class="detail-card" style="padding:16px">
            ${(tx.vin ?? []).map(inp => inputBlock(inp)).join('')}
          </div>
        </div>
        <div>
          <div class="section-title">Outputs (${(tx.vout ?? []).length})</div>
          <div class="detail-card" style="padding:16px">
            ${(tx.vout ?? []).map(out => outputBlock(out)).join('')}
          </div>
        </div>
      </div>
    </div>`;
  } catch (e) {
    renderError('Transaction not found: ' + e.message);
  }
}

function inputBlock(inp) {
  if (inp.coinbase) {
    return `<div class="io-row">
      <div><div class="io-label">Coinbase</div><div class="mono" style="font-size:11px;color:var(--muted)">${inp.coinbase.slice(0, 40)}…</div></div>
      <div class="io-amount">New coins</div>
    </div>`;
  }
  if (inp.key_image) {
    const ringSize = Array.isArray(inp.ring_members) ? inp.ring_members.length : '?';
    return `<div class="io-row">
      <div>
        <div class="confidential-badge">Private Input · Ring-${ringSize}</div>
        <div class="mono" style="font-size:10px;color:var(--muted);margin-top:4px">Key image: ${shortHash(inp.key_image, 12)}</div>
      </div>
      <div class="io-amount">hidden</div>
    </div>`;
  }
  const addr = inp.prevout?.scriptpubkey_address ?? inp.address ?? '';
  return `<div class="io-row">
    <div>
      ${addr ? `<a href="#/address/${addr}" class="mono hash-short" style="font-size:11px">${shortHash(addr, 20)}</a>` : '<span class="mono" style="font-size:11px;color:var(--muted)">unknown</span>'}
      <div class="io-label">${inp.txid ? shortHash(inp.txid, 10) + ':' + inp.vout : ''}</div>
    </div>
    <div class="io-amount">${inp.prevout?.value != null ? formatDIN(inp.prevout.value * DIN_PER_UNA) + ' DIN' : '—'}</div>
  </div>`;
}

function outputBlock(out) {
  if (out.is_confidential || out.confidential) {
    return `<div class="io-row">
      <div><div class="confidential-badge">Confidential Output</div></div>
      <div class="io-amount">hidden</div>
    </div>`;
  }
  const addr = out.scriptpubkey_address ?? out.address
    ?? out.scriptPubKey?.addresses?.[0]
    ?? out.scriptPubKey?.address ?? '';
  const val = out.value ?? (out.amount != null ? out.amount : null);
  return `<div class="io-row">
    <div>
      ${addr ? `<a href="#/address/${addr}" class="mono hash-short" style="font-size:11px">${shortHash(addr, 22)}</a>` : '<span style="color:var(--muted);font-size:11px">non-standard</span>'}
    </div>
    <div class="io-amount">${val != null ? Number(val).toFixed(8) + ' DIN' : '—'}</div>
  </div>`;
}

// ── Address ────────────────────────────────────────────────────────────────────
async function renderAddress(addr) {
  loading();
  try {
    const [balInfo, history] = await Promise.all([
      rpc('blockchain.getaddressbalance', [addr]).catch(() => null),
      rpc('blockchain.getaddresshistory', [addr]).catch(() => []),
    ]);

    const balance = balInfo?.balance ?? balInfo?.confirmed ?? null;
    const txList = Array.isArray(history) ? history : (history?.txids ?? []);

    app.innerHTML = `<div class="container">
      <div class="detail-card">
        <div class="detail-title">
          <span class="badge badge-teal">Address</span>
        </div>
        <div class="mono hash" style="word-break:break-all;margin-bottom:16px;font-size:13px">${addr}</div>
        <div class="balance-display">
          ${balance != null ? formatDIN(balance) : '—'}
          <span class="balance-unit">DIN</span>
        </div>
        ${balInfo?.unconfirmed ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">+ ${formatDIN(balInfo.unconfirmed)} DIN unconfirmed</div>` : ''}
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
                  const txid = typeof t === 'string' ? t : (t.txid ?? t.hash ?? JSON.stringify(t));
                  const height = t.height ?? null;
                  return `<tr>
                    <td><a href="#/tx/${txid}" class="hash-short mono">${shortHash(txid)}</a></td>
                    <td>${height != null ? `<a href="#/block/height/${height}">#${height.toLocaleString()}</a>` : '<span style="color:var(--muted)">unconfirmed</span>'}</td>
                    <td>${height != null ? '<span class="badge badge-green">Confirmed</span>' : '<span style="color:var(--muted)">Pending</span>'}</td>
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
