// Unipeg chain probe round 3 — runs on a GitHub Actions runner (open internet).
// 1. Full holder scan -> alive id->seed map (the complete renderable set)
// 2. Discover upeglens.art's real data path from its homepage/JS (polite, few requests)
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const TOKEN = '0x44b28991b167582f18ba0259e0173176ca125505';
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
];

const summary = { errors: [] };
mkdirSync('out3', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcIdx = 0;
async function rawCall(to, data) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const rpc = RPCS[(rpcIdx + attempt) % RPCS.length];
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${rpc}: ${JSON.stringify(j.error)}`); continue; }
      rpcIdx = (rpcIdx + attempt) % RPCS.length;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const strip = (h) => h.replace(/^0x/, '');
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrArg = (a) => strip(a).toLowerCase().padStart(64, '0');
const decU = (h, w = 0) => BigInt('0x' + strip(h).slice(w * 64, w * 64 + 64));
const decAddr = (h) => '0x' + strip(h).slice(24, 64);

// ------------------------------------------------------------- 1. holder scan
try {
  const holdersCount = Number(decU(await rawCall(TOKEN, '0x8c979559')));
  const totalCount = decU(await rawCall(TOKEN, '0xd396bbff')).toString();
  console.log('holders:', holdersCount, 'ever minted:', totalCount);
  const map = {}; // id -> seed (decimal strings)
  const holderOf = {}; // id -> holder address
  let scanned = 0, failures = 0;
  for (let hi = 0; hi < holdersCount; hi++) {
    try {
      const holder = decAddr(await rawCall(TOKEN, '0x1a773210' + u256(hi)));
      // pages of 80: OwnerUpegsPage(owner, page, pageSize)
      for (let page = 0; ; page++) {
        const hex = strip(await rawCall(TOKEN, '0x407d4fb4' + addrArg(holder) + u256(page) + u256(80)));
        const len = Number(BigInt('0x' + hex.slice(64, 128)));
        for (let k = 0; k < len; k++) {
          const base = 128 + k * 128;
          const id = BigInt('0x' + hex.slice(base, base + 64)).toString();
          map[id] = BigInt('0x' + hex.slice(base + 64, base + 128)).toString();
          holderOf[id] = holder;
        }
        if (len < 80) break;
        await sleep(25);
      }
      scanned++;
      if (hi % 100 === 0) console.log(`holder ${hi}/${holdersCount}, upegs so far: ${Object.keys(map).length}`);
    } catch (e) {
      failures++;
      summary.errors.push(`holder ${hi}: ${String(e).slice(0, 200)}`);
      if (failures > 40) throw new Error('too many holder failures, aborting scan');
    }
    await sleep(25);
  }
  const ids = Object.keys(map).map(Number);
  summary.scan = {
    holdersCount, scanned, failures,
    aliveCount: ids.length, everMinted: totalCount,
    idMin: Math.min(...ids), idMax: Math.max(...ids),
  };
  console.log('scan summary', summary.scan);
  writeFileSync('out3/alive_id_seed.json.gz', gzipSync(Buffer.from(JSON.stringify(map))));
  writeFileSync('out3/alive_id_holder.json.gz', gzipSync(Buffer.from(JSON.stringify(holderOf))));
} catch (e) {
  summary.errors.push('scan: ' + String(e));
  console.log('FAIL scan', String(e));
}

// ------------------------------------------------- 2. upeglens data path hunt
try {
  const ua = { 'user-agent': 'unipegPFP-build/1.0 (community tool build; few polite requests)' };
  const home = await (await fetch('https://upeglens.art/', { headers: ua, signal: AbortSignal.timeout(30000) })).text();
  writeFileSync('out3/upeglens_home.html', home.slice(0, 200000));
  const refs = [...home.matchAll(/(?:src|href)=["']([^"']+\.(?:js|json)[^"']*)["']/g)].map((m) => m[1]);
  const dataRefs = [...home.matchAll(/["']([^"']*(?:data|upeg)[^"']*\.json[^"']*)["']/g)].map((m) => m[1]);
  console.log('refs', refs, 'dataRefs', dataRefs);
  const found = { refs, dataRefs, probed: {} };
  // fetch referenced JS (max 4) and grep for .json paths
  const jsPaths = refs.filter((r) => r.endsWith('.js')).slice(0, 4);
  const jsonCandidates = new Set(dataRefs);
  for (const p of jsPaths) {
    const url = new URL(p, 'https://upeglens.art/').href;
    try {
      const js = await (await fetch(url, { headers: ua, signal: AbortSignal.timeout(30000) })).text();
      for (const m of js.matchAll(/["'`]([^"'`]{2,120}?\.json(?:\?[^"'`]*)?)["'`]/g)) jsonCandidates.add(m[1]);
      await sleep(300);
    } catch (e) { summary.errors.push(`js ${p}: ${e}`); }
  }
  found.jsonCandidates = [...jsonCandidates];
  // probe up to 6 candidates with HEAD-ish GET (range) requests
  for (const c of [...jsonCandidates].slice(0, 6)) {
    const url = new URL(c, 'https://upeglens.art/').href;
    try {
      const r = await fetch(url, { headers: { ...ua, range: 'bytes=0-2000', origin: 'https://example.com' }, signal: AbortSignal.timeout(30000) });
      const body = await r.text();
      found.probed[url] = {
        status: r.status,
        corsHeader: r.headers.get('access-control-allow-origin'),
        contentType: r.headers.get('content-type'),
        contentLength: r.headers.get('content-length') || r.headers.get('content-range'),
        head: body.slice(0, 400),
      };
      await sleep(300);
    } catch (e) { found.probed[url] = { error: String(e) }; }
  }
  // if a probe looks like the full dataset, fetch it whole once
  const best = Object.entries(found.probed).find(([, v]) => v.status && v.status < 300 && /^[\s\[{]/.test(v.head || '') && (v.head.includes('seed') || v.head.includes('trait') || v.head.includes('rarity')));
  if (best) {
    const [url] = best;
    const buf = Buffer.from(await (await fetch(url, { headers: ua, signal: AbortSignal.timeout(180000) })).arrayBuffer());
    found.fetched = { url, sizeBytes: buf.length };
    const gz = gzipSync(buf);
    if (gz.length < 80 * 1024 * 1024) { writeFileSync('out3/upeglens_dataset.json.gz', gz); found.fetched.gzBytes = gz.length; }
    try {
      const data = JSON.parse(buf.toString('utf8'));
      const entries = Array.isArray(data) ? data : typeof data === 'object' ? Object.values(data) : [];
      found.fetched.entryCount = entries.length;
      found.fetched.sample = entries.slice(0, 2);
    } catch (e) { found.fetched.parseError = String(e); }
  }
  summary.upeglens = found;
  writeFileSync('out3/upeglens_hunt.json', JSON.stringify(found, null, 2));
} catch (e) {
  summary.errors.push('lens hunt: ' + String(e));
  console.log('FAIL lens hunt', String(e));
}

writeFileSync('out3/summary.json', JSON.stringify(summary, null, 2));
console.log('DONE round 3. errors:', summary.errors.length);
