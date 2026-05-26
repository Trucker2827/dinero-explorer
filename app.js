// ── Config ─────────────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.realmoneyforfreepeople.org';
const DIN_PER_UNA = 100_000_000;
const BLOCKS_PER_PAGE = 10;
const AUTO_REFRESH_MS = 30_000;
const COINBASE_MATURITY = 100;
const TARGET_SPACING_SEC = 120;

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatHashrate(hashrate) {
  if (hashrate == null || !Number.isFinite(Number(hashrate))) return '—';
  const hr = Number(hashrate);
  if (hr >= 1e12) return `${(hr / 1e12).toFixed(2)} TH/s`;
  if (hr >= 1e9) return `${(hr / 1e9).toFixed(2)} GH/s`;
  if (hr >= 1e6) return `${(hr / 1e6).toFixed(2)} MH/s`;
  if (hr >= 1e3) return `${(hr / 1e3).toFixed(2)} KH/s`;
  return `${hr.toFixed(2)} H/s`;
}

function formatNBits(bits) {
  if (bits == null) return '—';
  if (typeof bits === 'string') {
    const clean = bits.trim().replace(/^0x/i, '');
    return clean ? `0x${clean.padStart(8, '0')}` : '—';
  }
  const n = Number(bits);
  return Number.isFinite(n) ? `0x${(n >>> 0).toString(16).padStart(8, '0')}` : '—';
}

function nBitsNumber(bits) {
  if (bits == null) return null;
  if (typeof bits === 'string') {
    const clean = bits.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
    return Number.parseInt(clean, 16) >>> 0;
  }
  const n = Number(bits);
  return Number.isFinite(n) ? (n >>> 0) : null;
}

function nBitsTargetHex(bits) {
  const compact = nBitsNumber(bits);
  if (compact == null) return '—';

  const exponent = compact >>> 24;
  const mantissa = compact & 0x007fffff;
  if (mantissa === 0 || (compact & 0x00800000)) return 'invalid';

  let target = BigInt(mantissa);
  if (exponent <= 3) {
    target >>= BigInt(8 * (3 - exponent));
  } else {
    target <<= BigInt(8 * (exponent - 3));
  }

  const maxTarget = (1n << 256n) - 1n;
  if (target < 0n || target > maxTarget) return 'invalid';
  return `0x${target.toString(16).padStart(64, '0')}`;
}

function shortTarget(bits) {
  const target = nBitsTargetHex(bits);
  if (target === '—' || target === 'invalid') return target;
  return shortHash(target.slice(2), 12);
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function formatDin(value, digits = 8) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })} DIN`;
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—';
  const b = Number(bytes);
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${b.toLocaleString()} B`;
}

function nodeHealth(info, tipBlock, now = Math.floor(Date.now() / 1000)) {
  const age = tipBlock?.time ? Math.max(0, now - tipBlock.time) : null;
  if (info.initialblockdownload) {
    return { label: 'Catching up', className: 'warn', detail: 'initial block download' };
  }
  if (age == null) {
    return { label: 'Unknown', className: 'warn', detail: 'tip time unavailable' };
  }
  if (age > TARGET_SPACING_SEC * 30) {
    return { label: 'Stale', className: 'danger', detail: `last block ${formatDuration(age)} ago` };
  }
  return { label: 'Synced', className: 'ok', detail: `last block ${formatDuration(age)} ago` };
}

function hexToBytes(hex) {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null;
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function decodeAscii(bytes) {
  if (!bytes || bytes.length === 0) return '';
  const text = bytes.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
  const printable = bytes.filter(b => b >= 32 && b <= 126).length;
  return printable >= Math.max(1, Math.ceil(bytes.length * 0.75)) ? text : '';
}

const OPCODE_NAMES = {
  0x00: 'OP_0',
  0x4c: 'OP_PUSHDATA1',
  0x4d: 'OP_PUSHDATA2',
  0x4e: 'OP_PUSHDATA4',
  0x51: 'OP_1',
  0x52: 'OP_2',
  0x53: 'OP_3',
  0x54: 'OP_4',
  0x55: 'OP_5',
  0x56: 'OP_6',
  0x57: 'OP_7',
  0x58: 'OP_8',
  0x59: 'OP_9',
  0x5a: 'OP_10',
  0x5b: 'OP_11',
  0x5c: 'OP_12',
  0x5d: 'OP_13',
  0x5e: 'OP_14',
  0x5f: 'OP_15',
  0x60: 'OP_16',
  0x6a: 'OP_RETURN',
  0x76: 'OP_DUP',
  0x87: 'OP_EQUAL',
  0x88: 'OP_EQUALVERIFY',
  0xa9: 'OP_HASH160',
  0xac: 'OP_CHECKSIG',
};

function decodeScriptPubKey(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes) return { asm: '', type: 'unknown', isOpReturn: false, opReturnHex: '', opReturnText: '' };

  const asm = [];
  const pushes = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++];
    if (op >= 0x01 && op <= 0x4b) {
      const data = bytes.slice(i, i + op);
      i += op;
      asm.push(`OP_PUSHBYTES_${op}`);
      if (data.length) asm.push(bytesToHex(data));
      pushes.push(data);
      continue;
    }
    if (op === 0x4c && i < bytes.length) {
      const len = bytes[i++];
      const data = bytes.slice(i, i + len);
      i += len;
      asm.push('OP_PUSHDATA1');
      asm.push(bytesToHex(data));
      pushes.push(data);
      continue;
    }
    if (op === 0x4d && i + 1 < bytes.length) {
      const len = bytes[i] | (bytes[i + 1] << 8);
      i += 2;
      const data = bytes.slice(i, i + len);
      i += len;
      asm.push('OP_PUSHDATA2');
      asm.push(bytesToHex(data));
      pushes.push(data);
      continue;
    }
    asm.push(OPCODE_NAMES[op] ?? `OP_${op.toString(16).padStart(2, '0').toUpperCase()}`);
  }

  const isOpReturn = bytes[0] === 0x6a;
  const opReturnBytes = isOpReturn ? pushes.flat() : [];
  const opReturnHex = opReturnBytes.length ? bytesToHex(opReturnBytes) : '';
  const opReturnText = decodeAscii(opReturnBytes);

  let type = 'custom';
  if (isOpReturn) type = 'OP_RETURN';
  else if (bytes.length === 34 && bytes[0] >= 0x51 && bytes[0] <= 0x60 && bytes[1] === 0x20) type = 'taproot';
  else if (bytes.length === 22 && bytes[0] === 0x00 && bytes[1] === 0x14) type = 'segwit_v0';
  else if (bytes.length === 25 && bytes[0] === 0x76 && bytes[1] === 0xa9 && bytes[2] === 0x14 && bytes[23] === 0x88 && bytes[24] === 0xac) type = 'legacy';

  return {
    asm: asm.join(' '),
    type,
    isOpReturn,
    opReturnHex,
    opReturnText,
  };
}

function outputTypeLabel(out, decoded) {
  if (decoded?.isOpReturn) return 'OP_RETURN';
  if (out.type && out.type !== 'legacy') return out.type;
  return decoded?.type && decoded.type !== 'custom' ? decoded.type : (out.type || 'custom');
}

function confirmationCount(tx, chainHeight) {
  const txHeight = Number(tx?.blockheight ?? tx?.height);
  const tip = Number(chainHeight);
  if (Number.isFinite(txHeight) && Number.isFinite(tip) && tip >= txHeight) {
    return Math.floor(tip - txHeight + 1);
  }

  const direct = Number(tx?.confirmations);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);
  return 0;
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
  const [info, mining, network, mempool] = await Promise.all([
    rpc('blockchain.getblockchaininfo'),
    rpc('blockchain.getmininginfo').catch(() => ({})),
    rpc('getnetworkinfo').catch(() => null),
    rpc('getmempoolinfo').catch(() => null),
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

  const updatedAt = Math.floor(Date.now() / 1000);
  const homeHtml = `${statsBar(info, mining, blocks[0], updatedAt)}${networkPanel(network, mempool)}${latestBlocksTable(blocks)}`;

  if (!silent) {
    app.innerHTML = `<div class="container">${homeHtml}</div>`;
  } else {
    // Soft refresh: update stats + table rows only
    const statsEl = app.querySelector('.stats-grid');
    const networkEl = app.querySelector('.network-panel');
    const tableEl = app.querySelector('tbody');
    if (statsEl) statsEl.outerHTML = statsBar(info, mining, blocks[0], updatedAt);
    if (networkEl) networkEl.outerHTML = networkPanel(network, mempool);
    if (tableEl) tableEl.innerHTML = blocks.map(blockRow).join('');
  }
}

function statsBar(info, mining, tipBlock, updatedAt) {
  const hashrate = mining.networkhashps ?? mining.hashespersec ?? info.networkhashps ?? null;
  const nbits = tipBlock?.bits ?? mining.nbits ?? mining.bits ?? info.nbits ?? null;
  const health = nodeHealth(info, tipBlock, updatedAt);

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
      <div class="stat-label">Node Status</div>
      <div class="stat-value"><span class="status-pill ${health.className}">${health.label}</span></div>
      <div class="stat-sub">${health.detail}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">nBits</div>
      <div class="stat-value">${formatNBits(nbits)}</div>
      <div class="stat-sub">target ${shortTarget(nbits)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Network Hashrate</div>
      <div class="stat-value">${formatHashrate(hashrate)}</div>
      <div class="stat-sub">estimated from recent blocks</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Money Supply</div>
      <div class="stat-value">${supply}</div>
      <div class="stat-sub">DIN circulating</div>
    </div>
  </div>`;
}

function networkPanel(network, mempool) {
  if (!network && !mempool) return '';

  const hasNetwork = Boolean(network);
  const active = hasNetwork && network.networkactive !== false;
  const reachable = hasNetwork && network.reachable !== false;
  const listen = hasNetwork && network.listen !== false;
  const connections = Number(network?.connections ?? 0);
  const inbound = Number(network?.connections_in ?? 0);
  const outbound = Number(network?.connections_out ?? 0);
  const mempoolSize = Number(mempool?.size ?? 0);
  const mempoolBytes = Number(mempool?.bytes ?? mempool?.usage ?? 0);
  const totalFee = mempool?.total_fee;
  const minRelay = mempool?.minrelaytxfee ?? mempool?.mempoolminfee;

  return `<div class="network-panel">
    <div class="mini-card">
      <div class="mini-label">P2P Network</div>
      <div class="mini-value">
        <span class="status-pill ${active && reachable ? 'ok' : 'warn'}">${!hasNetwork ? 'Unknown' : active && reachable ? 'Online' : 'Limited'}</span>
      </div>
      <div class="mini-grid">
        <span>Peers</span><strong>${connections.toLocaleString()}</strong>
        <span>Inbound</span><strong>${inbound.toLocaleString()}</strong>
        <span>Outbound</span><strong>${outbound.toLocaleString()}</strong>
        <span>Listen</span><strong>${listen ? 'yes' : 'no'}</strong>
      </div>
    </div>
    <div class="mini-card">
      <div class="mini-label">Public Port</div>
      <div class="mini-value">${network?.listen_port ?? '—'}</div>
      <div class="mini-sub">port mapping: ${escapeHtml(network?.port_mapping?.mode ?? 'unknown')} / ${escapeHtml(network?.port_mapping?.message ?? '—')}</div>
    </div>
    <div class="mini-card">
      <div class="mini-label">Mempool</div>
      <div class="mini-value">${mempoolSize.toLocaleString()} tx</div>
      <div class="mini-grid">
        <span>Size</span><strong>${formatBytes(mempoolBytes)}</strong>
        <span>Total fee</span><strong>${formatDin(totalFee)}</strong>
        <span>Min relay</span><strong>${formatDin(minRelay)}</strong>
      </div>
    </div>
  </div>`;
}

function latestBlocksTable(blocks) {
  return `<div class="section-title" style="margin-bottom:12px">Latest Blocks <span class="auto-refresh-badge">↻ auto-refresh</span></div>
  <div class="card">
    <table>
      <thead>
        <tr><th>Height</th><th>Hash</th><th>Time</th><th>Txns</th><th>nBits</th><th>Nonce</th></tr>
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
      <td class="mono" style="color:var(--muted);font-size:11px">—</td>
    </tr>`;
  }
  const hash  = b.hash ?? '';
  const h     = b.height;
  const txn   = b.nTx ?? (Array.isArray(b.tx) ? b.tx.length : '?');
  const time  = b.time ?? null;
  const nonce = b.nonce ?? '—';
  const nbits = formatNBits(b.bits);
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
    <td class="mono" style="color:var(--muted);font-size:11px">${nbits}</td>
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

    const [b, info] = await Promise.all([
      rpc('blockchain.getblock', [hash, 1]),
      rpc('blockchain.getblockchaininfo').catch(() => ({})),
    ]);
    const txids = Array.isArray(b.tx) ? b.tx : [];
    const height = b.height ?? '?';
    const chainHeight = Number(info.blocks);
    const blockHeight = Number(height);
    const confirmations = Number.isFinite(chainHeight) && Number.isFinite(blockHeight) && chainHeight >= blockHeight
      ? chainHeight - blockHeight + 1
      : null;

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

          <span class="detail-label">Confirmations</span>
          <span class="detail-value">${confirmations != null ? confirmations.toLocaleString() : '—'}<span class="detail-help">block depth in the active chain</span></span>

          <span class="detail-label">Transactions</span>
          <span class="detail-value">${txids.length}</span>

          <span class="detail-label">Nonce</span>
          <span class="detail-value mono">${b.nonce ?? '—'}</span>

          <span class="detail-label">nBits</span>
          <span class="detail-value mono">${formatNBits(b.bits)}</span>

          <span class="detail-label">PoW Target</span>
          <span class="detail-value hash" style="font-size:11px">${nBitsTargetHex(b.bits)}</span>

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
    const [tx, info] = await Promise.all([
      rpc('gettransaction', [txid]),
      rpc('blockchain.getblockchaininfo').catch(() => ({})),
    ]);
    if (!tx) throw new Error('not found');

    const inputs  = tx.inputs  ?? [];
    const outputs = tx.outputs ?? [];
    const confirmations = confirmationCount(tx, info.blocks);
    const maturity = coinbaseMaturity(tx, confirmations);

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
          <span class="detail-value">${confirmations.toLocaleString()}<span class="detail-help">blocks deep, not node count</span></span>

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

      ${maturity}

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

function coinbaseMaturity(tx, confirmations) {
  if (!tx?.is_coinbase) return '';
  const remaining = Math.max(0, COINBASE_MATURITY - confirmations);
  const progress = Math.min(100, Math.max(0, (confirmations / COINBASE_MATURITY) * 100));
  const mature = remaining === 0;
  const estimate = mature
    ? 'spendable now'
    : `about ${formatDuration(remaining * TARGET_SPACING_SEC)} remaining at 2-minute target spacing`;

  return `<div class="detail-card maturity-card">
    <div class="detail-title">
      <span class="badge ${mature ? 'badge-green' : 'badge-blue'}">${mature ? 'Mature' : 'Immature'}</span>
      Coinbase Maturity
    </div>
    <div class="maturity-row">
      <div>
        <div class="maturity-main">${Math.min(confirmations, COINBASE_MATURITY).toLocaleString()} / ${COINBASE_MATURITY.toLocaleString()} confirmations</div>
        <div class="maturity-sub">${mature ? 'Coinbase reward has reached consensus maturity.' : `${remaining.toLocaleString()} more confirmations before this reward is spendable.`}</div>
      </div>
      <div class="maturity-eta">${estimate}</div>
    </div>
    <div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${progress.toFixed(1)}%"></div></div>
  </div>`;
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
  const spk  = out.scriptPubKey ?? '';
  const decoded = decodeScriptPubKey(spk);
  const typeLabel = outputTypeLabel(out, decoded);
  const vout = out.vout != null ? `#${out.vout}` : '';
  let addrDisplay = '';

  if (out.address) {
    addrDisplay = `<a href="#/address/${out.address}" class="mono hash-short" style="font-size:11px">${shortHash(out.address, 22)}</a>`;
  } else if (decoded.isOpReturn) {
    addrDisplay = `<span class="op-return-preview">${decoded.opReturnText
      ? escapeHtml(decoded.opReturnText)
      : (decoded.opReturnHex ? shortHash(decoded.opReturnHex, 18) : 'OP_RETURN')}</span>`;
  } else if (spk) {
    addrDisplay = `<span class="mono" style="font-size:10px;color:var(--muted)">${shortHash(spk, 14)}</span>`;
  }

  return `<div class="io-row">
    <div>
      <div class="io-meta">
        ${vout ? `<span class="output-index">${vout}</span>` : ''}
        <span class="badge ${decoded.isOpReturn ? 'badge-amber' : 'badge-blue'}">${escapeHtml(typeLabel)}</span>
      </div>
      ${addrDisplay}
      ${scriptDetails(spk, decoded)}
    </div>
    <div class="io-amount">${val != null ? parseFloat(val).toFixed(8) + ' DIN' : '—'}</div>
  </div>`;
}

function scriptDetails(spk, decoded) {
  if (!spk) return '';
  const opReturnText = decoded.opReturnText
    ? `<span class="script-label">OP_RETURN data</span><span class="op-return-data">${escapeHtml(decoded.opReturnText)}</span>`
    : decoded.opReturnHex
      ? `<span class="script-label">OP_RETURN data</span><span class="script-value">${escapeHtml(decoded.opReturnHex)}</span>`
      : '';

  return `<details class="script-details">
    <summary>Script details</summary>
    <div class="script-grid">
      <span class="script-label">ASM</span>
      <span class="script-value">${escapeHtml(decoded.asm || '—')}</span>
      <span class="script-label">HEX</span>
      <span class="script-value">${escapeHtml(spk)}</span>
      ${opReturnText}
      <span class="script-label">Type</span>
      <span class="script-value">${escapeHtml(decoded.type || 'unknown')}</span>
    </div>
  </details>`;
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
