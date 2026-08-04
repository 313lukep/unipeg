#!/usr/bin/env node
// Full holder scan -> block-stamped alive snapshot.
// Runs anywhere with open internet (GitHub Actions runner, your laptop).
// Writes public/data/upeg-alive.json + upeg-alive.meta.json, and a combined
// live payload out/upeg-live.json for the data-live branch.
//
// Usage: node scripts/scan-alive.mjs [outDir=public/data]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const TOKEN = "0x44b28991b167582f18ba0259e0173176ca125505";
const RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io",
];

const outDir = process.argv[2] ?? "public/data";
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[(rpcIdx + attempt) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
const call = (data) => rpc("eth_call", [{ to: TOKEN, data }, "latest"]);
const strip = (h) => h.replace(/^0x/, "");
const u256 = (n) => BigInt(n).toString(16).padStart(64, "0");
const addrArg = (a) => strip(a).toLowerCase().padStart(64, "0");
const decU = (h, w = 0) => BigInt("0x" + strip(h).slice(w * 64, w * 64 + 64));
const decAddr = (h) => "0x" + strip(h).slice(24, 64);

// Block recorded BEFORE the scan so event deltas overlap instead of gapping.
const blockNumber = Number(BigInt(await rpc("eth_blockNumber", [])));
const holdersCount = Number(decU(await call("0x8c979559"))); // HoldersCount()
const everMinted = Number(decU(await call("0xd396bbff"))); // UpegsTotalCount()
console.log(`block ${blockNumber}, holders ${holdersCount}, ever minted ${everMinted}`);

const map = {};
let failures = 0;
for (let hi = 0; hi < holdersCount; hi++) {
  try {
    const holder = decAddr(await call("0x1a773210" + u256(hi))); // Holder(i)
    for (let page = 0; ; page++) {
      // OwnerUpegsPage(owner, page, 80)
      const hex = strip(await call("0x407d4fb4" + addrArg(holder) + u256(page) + u256(80)));
      const len = Number(BigInt("0x" + hex.slice(64, 128)));
      for (let k = 0; k < len; k++) {
        const base = 128 + k * 128;
        map[BigInt("0x" + hex.slice(base, base + 64)).toString()] =
          BigInt("0x" + hex.slice(base + 64, base + 128)).toString();
      }
      if (len < 80) break;
      await sleep(20);
    }
  } catch (e) {
    failures++;
    console.error(`holder ${hi}: ${String(e).slice(0, 150)}`);
    if (failures > 40) throw new Error("too many holder failures — aborting");
  }
  if (hi % 200 === 0) console.log(`  ${hi}/${holdersCount} holders, ${Object.keys(map).length} upegs`);
  await sleep(20);
}

const ids = Object.keys(map).map(Number);
const meta = {
  blockNumber,
  scannedAt: new Date().toISOString(),
  holdersCount,
  failures,
  aliveCount: ids.length,
  everMinted,
  idMin: Math.min(...ids),
  idMax: Math.max(...ids),
  method: "full holder scan (Holder x HoldersCount, OwnerUpegsPage)",
};
writeFileSync(path.join(outDir, "upeg-alive.json"), JSON.stringify(map));
writeFileSync(path.join(outDir, "upeg-alive.meta.json"), JSON.stringify(meta, null, 2));
mkdirSync("out", { recursive: true });
writeFileSync("out/upeg-live.json", JSON.stringify({ ...meta, map }));
console.log("done:", JSON.stringify(meta));
