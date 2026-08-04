// Unipeg chain probe — runs on a GitHub Actions runner (open internet).
// Plain Node 20+, no deps. Proves the on-chain SVG renderer with real eth_calls.
import { writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = '0x44b28991b167582f18ba0259e0173176ca125505';
const HOOK_EXPECTED = '0xe54082dfbf044b6a8f584bdddb90a22d5613c440';
const RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://cloudflare-eth.com',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth.drpc.org',
];

const results = { steps: {}, rpcUsed: null, errors: [] };
mkdirSync('out', { recursive: true });

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
      results.rpcUsed = results.rpcUsed || rpc;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const strip = (h) => h.replace(/^0x/, '');
const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrArg = (a) => strip(a).toLowerCase().padStart(64, '0');
const decU = (h) => BigInt('0x' + strip(h).slice(0, 64));
const decAddr = (h) => '0x' + strip(h).slice(24, 64);
function decStr(h) {
  const hex = strip(h);
  const off = parseInt(hex.slice(0, 64), 16) * 2;
  const len = parseInt(hex.slice(off, off + 64), 16) * 2;
  const body = hex.slice(off + 64, off + 64 + len);
  return Buffer.from(body, 'hex').toString('utf8');
}

async function step(name, fn) {
  try {
    const v = await fn();
    results.steps[name] = { ok: true, value: v };
    console.log('OK', name, typeof v === 'string' && v.length > 200 ? v.slice(0, 120) + `... (${v.length} chars)` : v);
    return v;
  } catch (e) {
    results.steps[name] = { ok: false, error: String(e) };
    results.errors.push(`${name}: ${e}`);
    console.log('FAIL', name, String(e));
    return null;
  }
}

// --- token-level reads ---
const hook = await step('token.hook()', async () => decAddr(await rawCall(TOKEN, '0x7f5a7c7b')));
const imageParams = await step('token.imageParams()', async () => decAddr(await rawCall(TOKEN, '0x44fe6eac')));
const totalCount = await step('token.UpegsTotalCount()', async () => (await rawCall(TOKEN, '0xd396bbff'), decU(await rawCall(TOKEN, '0xd396bbff')).toString()));
const holdersCount = await step('token.HoldersCount()', async () => decU(await rawCall(TOKEN, '0x8c979559')).toString());
await step('token.UNIT_PER_UPEG()', async () => decU(await rawCall(TOKEN, '0x7636d7d4')).toString());
await step('token.totalSupply()', async () => decU(await rawCall(TOKEN, '0x18160ddd')).toString());
await step('token.decimals()', async () => decU(await rawCall(TOKEN, '0x313ce567')).toString());
await step('token.tokenURI(1) (expect revert)', async () => await rawCall(TOKEN, '0xc87b56dd' + u256(1)));

// --- find a real holder & seed; probe index base 0 and 1 ---
let holder0 = null, holderBase = null;
for (const i of [0, 1]) {
  try { holder0 = decAddr(await rawCall(TOKEN, '0x1a773210' + u256(i))); holderBase = i; break; } catch (e) { results.errors.push(`Holder(${i}): ${e}`); }
}
results.steps['token.Holder(base)'] = { ok: !!holder0, value: { holder: holder0, indexBase: holderBase } };
console.log('Holder base', holderBase, holder0);

let firstUpeg = null, upegIndexBase = null;
if (holder0) {
  await step(`token.OwnerUpegsCount(${holder0})`, async () => decU(await rawCall(TOKEN, '0x067b2601' + addrArg(holder0))).toString());
  for (const i of [0, 1]) {
    try {
      const ret = await rawCall(TOKEN, '0xeb011422' + addrArg(holder0) + u256(i));
      const hex = strip(ret);
      firstUpeg = { id: BigInt('0x' + hex.slice(0, 64)).toString(), seed: BigInt('0x' + hex.slice(64, 128)).toString() };
      upegIndexBase = i;
      break;
    } catch (e) { results.errors.push(`OwnerUpeg(h,${i}): ${e}`); }
  }
  results.steps['token.OwnerUpeg(holder0, base)'] = { ok: !!firstUpeg, value: { ...firstUpeg, indexBase: upegIndexBase } };
  console.log('OwnerUpeg base', upegIndexBase, firstUpeg);
  // page base probe: page argument 0 vs 1
  for (const p of [0, 1]) {
    await step(`token.OwnerUpegsPage(holder0, page=${p}, size=2)`, async () => {
      const ret = await rawCall(TOKEN, '0x407d4fb4' + addrArg(holder0) + u256(p) + u256(2));
      const hex = strip(ret);
      const off = parseInt(hex.slice(0, 64), 16) * 2;
      const n = parseInt(hex.slice(off, off + 64), 16);
      const items = [];
      for (let k = 0; k < n; k++) {
        const base = off + 64 + k * 128;
        items.push({ id: BigInt('0x' + hex.slice(base, base + 64)).toString(), seed: BigInt('0x' + hex.slice(base + 64, base + 128)).toString() });
      }
      return items;
    });
  }
}

// --- mid-range holder for a second sample ---
let midUpeg = null;
if (holdersCount && holderBase !== null) {
  await step('mid holder upeg', async () => {
    const mid = BigInt(holdersCount) / 2n + BigInt(holderBase);
    const h = decAddr(await rawCall(TOKEN, '0x1a773210' + u256(mid)));
    const ret = await rawCall(TOKEN, '0xeb011422' + addrArg(h) + u256(upegIndexBase ?? 0));
    const hex = strip(ret);
    midUpeg = { holderIndex: mid.toString(), holder: h, id: BigInt('0x' + hex.slice(0, 64)).toString(), seed: BigInt('0x' + hex.slice(64, 128)).toString() };
    return midUpeg;
  });
}

// --- THE renderer call: UpegHook.generate(uint256 seed) -> string SVG ---
const hookAddr = hook || HOOK_EXPECTED;
results.hookAddr = hookAddr;
if (firstUpeg) {
  await step('hook.generate(seed of first upeg)', async () => {
    const svg = decStr(await rawCall(hookAddr, '0x4a7dd523' + u256(firstUpeg.seed)));
    writeFileSync('out/sample.svg', svg);
    writeFileSync('out/sample.meta.json', JSON.stringify({ ...firstUpeg, holder: holder0, renderer: hookAddr }, null, 2));
    return `saved out/sample.svg (${svg.length} chars)`;
  });
}
if (midUpeg) {
  await step('hook.generate(seed of mid upeg)', async () => {
    const svg = decStr(await rawCall(hookAddr, '0x4a7dd523' + u256(midUpeg.seed)));
    writeFileSync('out/sample2.svg', svg);
    writeFileSync('out/sample2.meta.json', JSON.stringify({ ...midUpeg, renderer: hookAddr }, null, 2));
    return `saved out/sample2.svg (${svg.length} chars)`;
  });
}
// does generate() live on imageParams too?
if (imageParams && firstUpeg && imageParams.toLowerCase() !== hookAddr.toLowerCase()) {
  await step('imageParams.generate(seed)', async () => {
    const svg = decStr(await rawCall(imageParams, '0x4a7dd523' + u256(firstUpeg.seed)));
    return `renders too (${svg.length} chars)`;
  });
}
await step('hook.getImageParams() raw', async () => {
  const ret = await rawCall(hookAddr, '0xf68de33d');
  writeFileSync('out/image_params.hex', ret);
  return `saved out/image_params.hex (${strip(ret).length / 2} bytes)`;
});

// --- verified ABI + source for token and hook ---
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
for (const [label, addr] of [['token', TOKEN], ['hook', hookAddr]]) {
  await step(`blockscout source ${label}`, async () => {
    const j = await getJson(`https://eth.blockscout.com/api/v2/smart-contracts/${addr}`);
    writeFileSync(`out/${label}_blockscout.json`, JSON.stringify(j, null, 1));
    return { name: j.name, compiler: j.compiler_version, hasAbi: !!j.abi, files: (j.additional_sources || []).length + 1 };
  });
  await step(`sourcify source ${label}`, async () => {
    const j = await getJson(`https://sourcify.dev/server/files/any/1/${addr}`);
    writeFileSync(`out/${label}_sourcify.json`, JSON.stringify(j, null, 1));
    return { status: j.status, files: (j.files || []).length };
  });
}

writeFileSync('out/results.json', JSON.stringify(results, null, 2));
console.log('DONE. errors:', results.errors.length);
