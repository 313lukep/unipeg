import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import {
  UPEG_RENDERER_ADDRESS,
  UPEG_TOKEN_ADDRESS,
  UpegLookupError,
} from "./types";

/**
 * Chain access. Both RPCs verified CORS-permissive for browser use
 * (probe round 2: preflight + POST both return ACAO for a foreign origin,
 * eth_chainId 0x1, ~150ms):
 *   - https://ethereum-rpc.publicnode.com  (ACAO: *)
 *   - https://eth.drpc.org                 (ACAO: origin-echo / *)
 * llamarpc returned 403 and 1rpc timed out in the same probe — not used.
 */
export const RPC_URLS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
] as const;

const RENDERER_ABI = [
  {
    type: "function",
    name: "generate",
    stateMutability: "view",
    inputs: [{ name: "seed", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
] as const;

const TOKEN_ABI = [
  {
    type: "function",
    name: "UpegsTotalCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "OwnerUpegsPage",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "page", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "seed", type: "uint256" },
        ],
      },
    ],
  },
] as const;

let defaultClient: PublicClient | undefined;

/** Lazily-created shared client; injectable in tests via the fns' `client` arg. */
export function getChainClient(): PublicClient {
  if (!defaultClient) {
    defaultClient = createPublicClient({
      chain: mainnet,
      transport: fallback(
        RPC_URLS.map((url) => http(url, { timeout: 12_000, retryCount: 1 })),
        { rank: false },
      ),
    });
  }
  return defaultClient;
}

/** Live SVG straight from the hook contract. Deterministic — cache forever. */
export async function chainGenerateSvg(
  seed: bigint,
  client: PublicClient = getChainClient(),
): Promise<string> {
  try {
    return await client.readContract({
      address: UPEG_RENDERER_ADDRESS,
      abi: RENDERER_ABI,
      functionName: "generate",
      args: [seed],
    });
  } catch (err) {
    throw new UpegLookupError(
      "network",
      `On-chain render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Ever-minted counter — also the maximum valid piece id. */
export async function chainTotalCount(
  client: PublicClient = getChainClient(),
): Promise<number> {
  try {
    const n = await client.readContract({
      address: UPEG_TOKEN_ADDRESS,
      abi: TOKEN_ABI,
      functionName: "UpegsTotalCount",
    });
    return Number(n);
  } catch (err) {
    throw new UpegLookupError(
      "network",
      `Could not read UpegsTotalCount: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
