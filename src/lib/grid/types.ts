/**
 * Core types for the Unipeg pixel grid engine.
 *
 * The single governing fact: Unipeg art is a 24x24 pixel grid rendered as
 * on-chain SVG. Everything in this library operates on integer cell
 * coordinates over arrays of hex colours. Conversion to device pixels happens
 * exactly once, at final rasterise.
 */

export type Grid = {
  /** width in cells; 24 for source art, larger for composed canvases */
  w: number;
  /** height in cells */
  h: number;
  /** row-major [y][x]; lowercase "#rrggbb" or null = transparent */
  cells: (string | null)[][];
  /** distinct colours present, lowercase "#rrggbb", sorted lexicographically */
  palette: string[];
};

/** Integer rectangle in cell coordinates. */
export type CellRect = { x: number; y: number; w: number; h: number };

/** Thrown whenever input fails to resolve to a valid cell grid. */
export class GridValidationError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "GridValidationError";
    this.reason = reason;
    // Restore prototype chain for ES5-ish targets so instanceof works.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
