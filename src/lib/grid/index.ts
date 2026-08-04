export { GridValidationError } from "./types";
export type { Grid, CellRect } from "./types";

export { makeGrid, cloneGrid, gridsEqual, recomputePalette } from "./grid";

export { svgToGridFromRects, svgToGrid } from "./svgToGrid";

export { imageToGrid } from "./imageToGrid";
export type { ImageDataLike } from "./imageToGrid";

export {
  detectBackground,
  contentBounds,
  keyOut,
  crop,
  pad,
  dilate,
  flattenOnto,
} from "./ops";

export { fullBodyCompose, contentInsideInscribedCircle } from "./circleFit";

export { detectHeadSeed } from "./headDetect";

export {
  hexToRgb,
  rgbToHex,
  relLuminance,
  contrastRatio,
  darken,
  dominantBodyColour,
  complementTint,
} from "./colour";

export { rasterise, rasteriseToCanvas, pickCellSize } from "./rasterise";
