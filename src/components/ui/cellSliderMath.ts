/**
 * Pure value maths for CellSlider — kept out of the component so the detent
 * behaviour is unit-testable.
 *
 * Detents act as magnets for POINTER input only: a raw value landing within
 * half a step of a detent snaps onto it, letting a drag find a detent that
 * may sit off the native step lattice (e.g. the sticker default -22 on a
 * 5-degree lattice). Keyboard input is exempt — arrow keys must step the
 * native lattice predictably, so a detent near a lattice value can never
 * capture (and thereby trap) a keyboard user.
 */

export type SliderInputSource = "pointer" | "keyboard";

export type SliderRange = {
  min: number;
  max: number;
  step: number;
  detents?: number[];
};

/** Clamp a raw slider value into [min, max]. */
export function clampToRange(raw: number, { min, max }: SliderRange): number {
  return Math.min(max, Math.max(min, raw));
}

/**
 * Resolve a raw native-input value to the value the slider should report.
 * Pointer input gets the detent magnet; keyboard input only clamps.
 */
export function resolveSliderValue(
  raw: number,
  range: SliderRange,
  source: SliderInputSource,
): number {
  const v = clampToRange(raw, range);
  if (source === "keyboard" || !range.detents) return v;
  for (const d of range.detents) {
    if (
      d >= range.min &&
      d <= range.max &&
      Math.abs(v - d) < range.step / 2 + 1e-9
    ) {
      return d;
    }
  }
  return v;
}
