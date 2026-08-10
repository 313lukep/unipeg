/**
 * Palettes copied verbatim from the verified SvgGenerator source
 * (0xe54082dfbf044b6a8f584bdddb90a22d5613c440). Duplicated entries
 * (#306082 at 11 & 13, #cbdbfc at 1 & 21) are faithful to the contract.
 */

/** Main colour palette — layer colour indices are modulo 36. */
export const UPEG_COLORS = [
  "#a9b6d2", "#cbdbfc", "#eae1b5", "#d9a066", "#9dcde4", "#8f563b",
  "#524b24", "#ac3232", "#d77bba", "#847e87", "#626979", "#306082",
  "#323c39", "#306082", "#6e3e54", "#cb67d2", "#37946e", "#df7126",
  "#d95763", "#5fcde4", "#d2ac8d", "#cbdbfc", "#696a6a", "#e7d632",
  "#e76232", "#cee6f3", "#e79090", "#fcf893", "#edb187", "#b3dcf7",
  "#4b8b3b", "#7fc97f", "#1e1e26", "#2d1b1b", "#a0a0a0", "#00ffd0",
] as const;

/** Background palette — background colour index is modulo 6. */
export const UPEG_BACKGROUND_COLORS = [
  "#1a1c2c", "#3a3f58", "#cbbba0", "#7a8ca8", "#394b3f", "#2e243f",
] as const;

/**
 * The background of the official @unipegv4 X avatar, sampled from the artwork
 * itself (400x400, every border pixel #cbdbfc). Not an arbitrary brand colour:
 * it is UPEG_COLORS[1] (and [21] — the duplicate the contract really carries),
 * so "match the official pfp" is exact, not approximated.
 */
export const OFFICIAL_PFP_BG = "#cbdbfc";
