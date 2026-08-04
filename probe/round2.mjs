// Unipeg chain probe round 2 — runs on a GitHub Actions runner (open internet).
// Plain Node 20+, no deps.
// 1. Extract every layer's rects from the on-chain SvgGenerator via crafted seeds
// 2. Fetch + analyse upeglens.art/data/upegs_full.json (once, politely)
// 3. Real CORS probes against public RPCs
// 4. Verification fixtures: (id, seed) pairs + a dozen real SVGs
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const TOKEN = '0x44b28991b167582f18ba0259e0173176ca125505';
const HOOK = '0xe54082dfbf044b6a8f584bdddb90a22d5613c440';
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://eth-mainnet.public.blastapi.io',
];

const summary = { errors: [] };
mkdirSync('out2', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCall(to, data) {
  let lastErr;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${rpc}: ${JSON.stringify(j.error)}`); continue; }
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const strip = (h) => h.replace(/^0x/, '');
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrArg = (a) => strip(a).toLowerCase().padStart(64, '0');
const decU = (h, word = 0) => BigInt('0x' + strip(h).slice(word * 64, word * 64 + 64));
const decAddr = (h) => '0x' + strip(h).slice(24, 64);
function decStr(h) {
  const hex = strip(h);
  const off = parseInt(hex.slice(0, 64), 16) * 2;
  const len = parseInt(hex.slice(off, off + 64), 16) * 2;
  return Buffer.from(hex.slice(off + 64, off + 64 + len), 'hex').toString('utf8');
}

// ---------------------------------------------------------------- 1. layers
// Seed bit offsets per UpegMetadataLibrary (trait slots; colors stay 0)
const OFFSETS = {
  horn: 8n, accessories: 16n, hair: 24n, wings: 32n, tail: 40n,
  legsFront: 48n, legsBack: 56n, eyes: 64n, body: 72n, ground: 80n,
};
// ImageParams struct order
const IP_FIELDS = ['colorsCount', 'backgroundColorsCount', 'accessoriesCount', 'bodyCount', 'eyesCount',
  'hairCount', 'hornCount', 'legsFrontCount', 'legsBackCount', 'tailCount', 'groundCount', 'wingsCount'];

const RECT_RE = /<rect x='(\d+)' y='(\d+)' width='(\d+)' height='(\d+)' fill='([^']+)'\/>/g;
function parseRects(svg) {
  const out = [];
  for (const m of svg.matchAll(RECT_RE)) {
    out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], fill: m[5] });
  }
  return out;
}

const ipHex = await rawCall(HOOK, '0xf68de33d');
const params = {};
IP_FIELDS.forEach((f, i) => { params[f] = Number(decU(ipHex, i)); });
console.log('imageParams', params);
summary.imageParams = params;

const layers = {};
for (const [slot, off] of Object.entries(OFFSETS)) {
  const count = params[slot + 'Count'];
  layers[slot] = [];
  for (let v = 1; v <= count; v++) {
    const seed = BigInt(v) << off;
    try {
      const svg = decStr(await rawCall(HOOK, '0x4a7dd523' + u256(seed)));
      const rects = parseRects(svg);
      const bg = rects.shift(); // full-bleed background rect
      if (!bg || bg.w !== 24 || bg.h !== 24) throw new Error('unexpected background rect: ' + JSON.stringify(bg));
      layers[slot].push({ variant: v, rects: rects.map(({ x, y, w, h }) => [x, y, w, h]) });
      console.log(`layer ${slot} v${v}: ${rects.length} rects`);
    } catch (e) {
      summary.errors.push(`layer ${slot} v${v}: ${e}`);
      console.log(`FAIL layer ${slot} v${v}:`, String(e));
    }
    await sleep(60);
  }
}
writeFileSync('out2/layers.json', JSON.stringify({ params, layers }));
console.log('layers.json written');

// ---------------------------------------------------------------- 2. upeglens dataset
try {
  const t0 = Date.now();
  const r = await fetch('https://upeglens.art/data/upegs_full.json', {
    headers: {
      'user-agent': 'unipegPFP-build/1.0 (one-time cache for a community PFP tool; respectful single fetch)',
      'origin': 'https://example.com',
    },
    signal: AbortSignal.timeout(180000),
  });
  const corsHeader = r.headers.get('access-control-allow-origin');
  const buf = Buffer.from(await r.arrayBuffer());
  const lens = { status: r.status, corsHeader, sizeBytes: buf.length, ms: Date.now() - t0,
    contentType: r.headers.get('content-type'), server: r.headers.get('server') };
  console.log('upeglens fetch', lens);

  const data = JSON.parse(buf.toString('utf8'));
  const entries = Array.isArray(data) ? data
    : Array.isArray(data.upegs) ? data.upegs
    : typeof data === 'object' ? Object.values(data) : [];
  lens.topLevel = Array.isArray(data) ? 'array' : typeof data === 'object' ? `object keys: ${Object.keys(data).slice(0, 10).join(',')}` : typeof data;
  lens.entryCount = entries.length;
  lens.sampleEntries = entries.slice(0, 3);
  const keyCounts = {};
  for (const e of entries.slice(0, 200)) for (const k of Object.keys(e || {})) keyCounts[k] = (keyCounts[k] || 0) + 1;
  lens.fieldFrequency = keyCounts;

  // hunt for id + seed fields
  const first = entries.find((e) => e && typeof e === 'object') || {};
  const idKey = ['id', 'upegId', 'upeg_id', 'number', 'tokenId'].find((k) => k in first);
  const seedKey = ['seed', 'Seed', 's', 'seedValue', 'seed_hex'].find((k) => k in first);
  lens.idKey = idKey; lens.seedKey = seedKey;
  if (idKey) {
    const ids = entries.map((e) => Number(e[idKey])).filter(Number.isFinite);
    lens.idMin = Math.min(...ids); lens.idMax = Math.max(...ids);
  }
  if (idKey && seedKey) {
    const map = {};
    for (const e of entries) map[String(e[idKey])] = String(e[seedKey]);
    const gz = gzipSync(Buffer.from(JSON.stringify(map)));
    writeFileSync('out2/id_seed_map.json.gz', gz);
    lens.idSeedMapGzBytes = gz.length;
  }
  const fullGz = gzipSync(buf);
  if (fullGz.length < 80 * 1024 * 1024) {
    writeFileSync('out2/upegs_full.json.gz', fullGz);
    lens.fullGzBytes = fullGz.length;
  } else {
    lens.fullGzBytes = fullGz.length;
    lens.fullGzSkipped = true;
  }
  summary.upeglens = lens;
  writeFileSync('out2/upeglens_summary.json', JSON.stringify(lens, (k, v) => k === 'sampleEntries' ? v : v, 2));
} catch (e) {
  summary.errors.push('upeglens: ' + String(e));
  summary.upeglens = { failed: String(e) };
  console.log('FAIL upeglens', String(e));
}

// ---------------------------------------------------------------- 3. CORS probes
const cors = [];
for (const rpc of RPCS.concat(['https://eth.merkle.io'])) {
  const rec = { url: rpc };
  try {
    const t0 = Date.now();
    const pre = await fetch(rpc, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
      signal: AbortSignal.timeout(15000),
    });
    rec.preflightStatus = pre.status;
    rec.preflightACAO = pre.headers.get('access-control-allow-origin');
    const post = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(15000),
    });
    rec.postStatus = post.status;
    rec.postACAO = post.headers.get('access-control-allow-origin');
    const j = await post.json();
    rec.chainId = j.result;
    rec.latencyMs = Date.now() - t0;
    rec.corsPermissive = (rec.preflightACAO === '*' || rec.preflightACAO === 'https://example.com')
      && (rec.postACAO === '*' || rec.postACAO === 'https://example.com') && rec.chainId === '0x1';
  } catch (e) { rec.error = String(e); rec.corsPermissive = false; }
  cors.push(rec);
  console.log('cors', rec.url, rec.corsPermissive, rec.preflightACAO, rec.postACAO);
}
writeFileSync('out2/rpc_cors.json', JSON.stringify(cors, null, 2));
summary.cors = cors;

// ---------------------------------------------------------------- 4. fixtures
try {
  const holdersCount = Number(decU(await rawCall(TOKEN, '0x8c979559')));
  const picks = [];
  const step = Math.max(1, Math.floor(holdersCount / 16));
  for (let i = 0; i < holdersCount && picks.length < 16; i += step) picks.push(i);
  const pairs = [];
  for (const hi of picks) {
    try {
      const holder = decAddr(await rawCall(TOKEN, '0x1a773210' + u256(hi)));
      // OwnerUpegsPage(owner, page 0, pageSize 3) -> UpegSeedData[]
      const hex = strip(await rawCall(TOKEN, '0x407d4fb4' + addrArg(holder) + u256(0) + u256(3)));
      const len = Number(BigInt('0x' + hex.slice(64, 128)));
      for (let k = 0; k < len; k++) {
        const base = 128 + k * 128;
        pairs.push({
          id: BigInt('0x' + hex.slice(base, base + 64)).toString(),
          seed: BigInt('0x' + hex.slice(base + 64, base + 128)).toString(),
          holderIndex: hi,
        });
      }
    } catch (e) { summary.errors.push(`fixture holder ${hi}: ${e}`); }
    await sleep(60);
  }
  // full SVGs for a spread of 14
  const svgPicks = pairs.filter((_, i) => i % Math.max(1, Math.floor(pairs.length / 14)) === 0).slice(0, 14);
  for (const p of svgPicks) {
    try {
      p.svg = decStr(await rawCall(HOOK, '0x4a7dd523' + u256(BigInt(p.seed))));
    } catch (e) { summary.errors.push(`fixture svg ${p.id}: ${e}`); }
    await sleep(60);
  }
  writeFileSync('out2/fixtures.json', JSON.stringify({ holdersCount, pairs }, null, 1));
  summary.fixtures = { holdersCount, pairCount: pairs.length, svgCount: svgPicks.filter((p) => p.svg).length };
  console.log('fixtures', summary.fixtures);
} catch (e) {
  summary.errors.push('fixtures: ' + String(e));
  console.log('FAIL fixtures', String(e));
}

writeFileSync('out2/summary.json', JSON.stringify(summary, null, 2));
console.log('DONE. errors:', summary.errors.length);
for (const f of ['out2/layers.json', 'out2/fixtures.json', 'out2/rpc_cors.json', 'out2/summary.json']) {
  try { console.log(f, statSync(f).size, 'bytes'); } catch {}
}
