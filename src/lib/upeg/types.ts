/**
 * Types for the on-chain Unipeg data model.
 *
 * Verified facts (Phase 0 discovery, see docs/DISCOVERY.md):
 * - $uPEG token: 0x44b28991b167582f18ba0259e0173176ca125505 (Ethereum mainnet)
 * - Renderer (UpegHook / SvgGenerator): 0xe54082dfbf044b6a8f584bdddb90a22d5613c440
 * - Upeg ids are global mint serials (max = UpegsTotalCount()), NOT 1..10000.
 *   10,000 caps *alive* upegs; burned/pooled ids have their seeds deleted on-chain.
 * - The art is a 24x24 pixel grid rendered as SVG by `generate(uint256 seed)`.
 */

/** Decoded seed — mirrors UpegMetadata in the verified contract source. */
export type UpegMetadata = {
  backGroundColor: number;
  body: number;
  eyes: number;
  hair: number;
  horn: number;
  legsBack: number;
  legsFront: number;
  wings: number;
  tail: number;
  accessories: number;
  ground: number;
  bodyColor: number; // legs and wings share this colour
  eyesColor: number;
  hairColor: number;
  hornColor: number;
  groundColor: number;
  accessoriesColor: number;
  tailColor: number;
};

/** Where the art we are showing actually came from. */
export type Provenance =
  | "chain" // SVG string returned by the hook contract via eth_call
  | "local-verified" // rendered by our TS port of the on-chain renderer (byte-exact, fixture-verified)
  | "recovered"; // reconstructed from an uploaded/pasted raster image

export type UpegPiece = {
  id: number;
  seed: bigint;
  svg: string;
  metadata: UpegMetadata;
  provenance: Provenance;
};

/** Typed failures — every fetch path returns one of these, never a silent blank. */
export type UpegLookupErrorCode =
  | "invalid-id" // not an integer >= 1
  | "out-of-range" // beyond UpegsTotalCount
  | "not-alive" // minted once, but burned/pooled — no seed exists on-chain any more
  | "network" // RPC unreachable / all transports failed
  | "dataset-unavailable"; // the bundled alive-set could not be loaded

export class UpegLookupError extends Error {
  code: UpegLookupErrorCode;
  id?: number;
  constructor(code: UpegLookupErrorCode, message: string, id?: number) {
    super(message);
    this.name = "UpegLookupError";
    this.code = code;
    this.id = id;
  }
}

export const UPEG_TOKEN_ADDRESS =
  "0x44b28991b167582f18ba0259e0173176ca125505" as const;
export const UPEG_RENDERER_ADDRESS =
  "0xe54082dfbf044b6a8f584bdddb90a22d5613c440" as const;
