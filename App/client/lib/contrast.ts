/**
 * WCAG 2.x colour contrast, for the visual-system tests and anything that has
 * to pick a readable colour at run time.
 *
 * Colours are plain sRGB with alpha. A translucent colour only has a contrast
 * once it is painted over something opaque, so `contrastRatio` composites the
 * foreground over the background first, the way a browser paints text.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function channel(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return clamp((Number.parseFloat(trimmed) / 100) * 255, 0, 255);
  return clamp(Number.parseFloat(trimmed), 0, 255);
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return clamp(Number.parseFloat(trimmed) / 100, 0, 1);
  return clamp(Number.parseFloat(trimmed), 0, 1);
}

/**
 * Parse the colour strings a stylesheet or `getComputedStyle` produces:
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` / `rgba(…)` in comma or
 * space syntax (`rgb(15 23 42 / 0.5)`), and `transparent`. Anything else —
 * a gradient, `currentColor`, a wide-gamut space — is `null`, which callers
 * treat as "cannot judge" rather than guessing.
 */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const pairs = digits.match(/../g)!.map((pair) => Number.parseInt(pair, 16));
    return { r: pairs[0], g: pairs[1], b: pairs[2], a: pairs.length === 4 ? pairs[3] / 255 : 1 };
  }
  const fn = /^rgba?\((.*)\)$/.exec(value);
  if (!fn) return null;
  const body = fn[1].trim();
  let parts: string[];
  let alphaPart: string | undefined;
  if (body.includes(",")) {
    parts = body.split(",");
    if (parts.length === 4) alphaPart = parts.pop();
  } else {
    const [rgb, slashAlpha] = body.split("/");
    parts = rgb.trim().split(/\s+/);
    alphaPart = slashAlpha;
  }
  if (parts.length !== 3) return null;
  const color = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha(alphaPart) };
  return [color.r, color.g, color.b, color.a].some((n) => Number.isNaN(n)) ? null : color;
}

/** Paint `top` over `bottom` (source-over). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** Composite a stack of layers, nearest first, over an opaque fallback. */
export function flatten(layers: Rgba[], fallback: Rgba = { r: 255, g: 255, b: 255, a: 1 }): Rgba {
  return [...layers].reverse().reduce((below, layer) => composite(layer, below), fallback);
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Contrast between text and what is behind it, 1–21. A translucent
 * background is first laid over white, a translucent foreground over the
 * resulting background.
 */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const bg = background.a < 1 ? composite(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
  const fg = foreground.a < 1 ? composite(foreground, bg) : foreground;
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience for two CSS colour strings; throws on one it cannot read. */
export function contrastOf(foreground: string, background: string): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) throw new Error(`Cannot compare ${foreground} with ${background}`);
  return contrastRatio(fg, bg);
}

/**
 * WCAG's "large text": 24px and up, or 18.66px (14pt) and up when bold. Large
 * text needs 3:1 at AA; everything else 4.5:1.
 */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

/** The AA minimum for text of this size and weight. */
export function aaMinimum(fontSizePx: number, fontWeight: number): number {
  return isLargeText(fontSizePx, fontWeight) ? AA_LARGE : AA_NORMAL;
}

/** Ratio rounded down to two places, the way checkers report it (4.499 is not 4.5). */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}
