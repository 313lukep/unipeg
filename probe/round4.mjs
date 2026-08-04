// Unipeg chain probe round 4 — fresh alive scan WITH block number + live event-delta demo.
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const TOKEN = '0x44b28991b167582f18ba0259e0173176ca125505';
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
];
const TOPIC_MINTED = '0xba672d3bb0dbc4a96e8acab68a5e7516856ae3b3e765a36fb04c0a12233500cb';
const TOPIC_BURNED = '0xdbe6d1112182468d7ed7e2e6f0e32c1182a22537cbf85dec665b7ed8c7946339';
const TOPIC_TRANSFER = '0x1a1b92e5be5fe65acbbf02ce8b542a441d04d5e488d362aea466ccb4672581ea';

const summary = { errors: [] };
mkdirSync('out4', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[(rpcIdx + attempt) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(25000),
      });
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${url}: ${JSON.stringify(j.error)}`); continue; }
      rpcIdx = (rpcIdx + attempt) % RPCS.length;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const rawCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const strip = (h) => h.replace(/^0x/, '');
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrArg = (a) => strip(a).toLowerCase().padStart(64, '0');
const decU = (h, w = 0) => BigInt('0x' + strip(h).slice(w * 64, w * 64 + 64));
const decAddr = (h) => '0x' + strip(h).slice(24, 64);

// -------- 1. block-stamped fresh scan (block recorded BEFORE scan => overlap-safe deltas)
const startBlock = Number(BigInt(await rpc('eth_blockNumber', [])));
console.log('snapshot base block:', startBlock);
const holdersCount = Number(decU(await rawCall(TOKEN, '0x8c979559')));
const everMinted = decU(await rawCall(TOKEN, '0xd396bbff')).toString();
const map = {};
let failures = 0;
for (let hi = 0; hi < holdersCount; hi++) {
  try {
    const holder = decAddr(await rawCall(TOKEN, '0x1a773210' + u256(hi)));
    for (let page = 0; ; page++) {
      const hex = strip(await rawCall(TOKEN, '0x407d4fb4' + addrArg(holder) + u256(page) + u256(80)));
      const len = Number(BigInt('0x' + hex.slice(64, 128)));
      for (let k = 0; k < len; k++) {
        const base = 128 + k * 128;
        map[BigInt('0x' + hex.slice(base, base + 64)).toString()] =
          BigInt('0x' + hex.slice(base + 64, base + 128)).toString();
      }
      if (len < 80) break;
      await sleep(20);
    }
    if (hi % 200 === 0) console.log(`holder ${hi}/${holdersCount}: ${Object.keys(map).length} upegs`);
  } catch (e) {
    failures++;
    summary.errors.push(`holder ${hi}: ${String(e).slice(0, 150)}`);
    if (failures > 40) throw new Error('too many failures');
  }
  await sleep(20);
}
const ids = Object.keys(map).map(Number);
summary.scan = {
  blockNumber: startBlock,
  scannedAt: new Date().toISOString(),
  holdersCount, failures,
  aliveCount: ids.length, everMinted: Number(everMinted),
  idMin: Math.min(...ids), idMax: Math.max(...ids),
};
console.log('scan', summary.scan);
writeFileSync('out4/alive_id_seed.json.gz', gzipSync(Buffer.from(JSON.stringify(map))));
writeFileSync('out4/alive_meta.json', JSON.stringify(summary.scan, null, 2));

// -------- 2. delta demo: replay events over the last ~6000 blocks and sanity-check
try {
  const demoFrom = startBlock - 6000;
  const getLogs = (topic) => rpc('eth_getLogs', [{
    address: TOKEN,
    topics: [topic],
    fromBlock: '0x' + demoFrom.toString(16),
    toBlock: 'latest',
  }]);
  const [minted, burned, transferred] = [await getLogs(TOPIC_MINTED), await getLogs(TOPIC_BURNED), await getLogs(TOPIC_TRANSFER)];
  const demo = {
    fromBlock: demoFrom,
    mintedCount: minted.length,
    burnedCount: burned.length,
    transferCount: transferred.length,
    sampleMint: minted.slice(-2).map((l) => ({
      block: Number(BigInt(l.blockNumber)),
      owner: '0x' + l.topics[1].slice(26),
      upegId: BigInt(l.data).toString(),
    })),
    sampleBurn: burned.slice(-2).map((l) => ({
      block: Number(BigInt(l.blockNumber)),
      upegId: BigInt(l.data).toString(),
    })),
  };
  // resolve seeds for the last few mints via OwnerUpegsPage on their current owner
  const lastOwners = {};
  for (const l of transferred) lastOwners[BigInt(l.data).toString()] = '0x' + l.topics[2].slice(26);
  demo.seedResolutions = [];
  for (const m of demo.sampleMint) {
    const owner = lastOwners[m.upegId] ?? m.owner;
    try {
      const hex = strip(await rawCall(TOKEN, '0x407d4fb4' + addrArg(owner) + u256(0) + u256(80)));
      const len = Number(BigInt('0x' + hex.slice(64, 128)));
      let found = null;
      for (let k = 0; k < len; k++) {
        const base = 128 + k * 128;
        if (BigInt('0x' + hex.slice(base, base + 64)).toString() === m.upegId) {
          found = BigInt('0x' + hex.slice(base + 64, base + 128)).toString();
        }
      }
      demo.seedResolutions.push({ upegId: m.upegId, owner, seed: found, inFreshScan: map[m.upegId] ?? null, agrees: found !== null && map[m.upegId] === found });
    } catch (e) { demo.seedResolutions.push({ upegId: m.upegId, error: String(e).slice(0, 150) }); }
  }
  summary.deltaDemo = demo;
  console.log('delta demo', JSON.stringify(demo, null, 2).slice(0, 1500));
} catch (e) {
  summary.errors.push('delta demo: ' + String(e));
}

writeFileSync('out4/summary.json', JSON.stringify(summary, null, 2));
console.log('DONE round 4. errors:', summary.errors.length);
