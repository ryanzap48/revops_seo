// lib/pixels.js
// Google truncates titles and descriptions by rendered width, not character
// count, so the report measures pixels. Widths are Arial advance widths in
// 1/1000 em units (from the Arial AFM metrics), scaled to the render size.

const W = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
  '–': 556, '—': 1000, '‘': 222, '’': 222, '“': 333, '”': 333, '•': 350, '…': 1000,
  '·': 278, '|': 260, '®': 737, '©': 737, '™': 1000, '°': 400, '€': 556, '£': 556,
};

const FALLBACK = 556;

/** Rendered width in CSS pixels of `text` at `fontSize` px in Arial. */
export function pixelWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) units += W[ch] ?? FALLBACK;
  return Math.round((units / 1000) * fontSize);
}

// Desktop SERP render sizes. Titles are set larger than descriptions, which is
// why a 60-character title can overflow while a 60-character snippet does not.
export const TITLE_FONT_PX = 20;
export const TITLE_MAX_PX = 580;
export const DESC_FONT_PX = 14;
export const DESC_MAX_PX = 1000;

export const titlePixels = (t) => pixelWidth(t, TITLE_FONT_PX);
export const descriptionPixels = (t) => pixelWidth(t, DESC_FONT_PX);
