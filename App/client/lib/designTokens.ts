/**
 * Genosyn's visual-system tokens: the handful of colours the App changes from
 * Tailwind's defaults, and the surfaces and text roles they are tuned against.
 *
 * `tailwind.config.ts` builds its palette from this module, and
 * `designTokens.test.ts` holds every text role to WCAG AA on every surface its
 * theme paints, so a token cannot drift below AA without a failing test.
 *
 * Pages keep writing ordinary Tailwind classes. The muted pair the App uses
 * everywhere — `text-slate-500 dark:text-slate-400` — and its quietest pair —
 * `text-slate-400 dark:text-slate-500` — now both pass AA in both themes, and
 * `text-emerald-600`, `text-amber-600` and friends are safe text colours on a
 * white card.
 */

export type ThemeName = "light" | "dark";

/** Tailwind v3's slate scale. Steps not listed in {@link THEME_SLATE} keep these. */
export const SLATE = {
  50: "#f8fafc",
  100: "#f1f5f9",
  200: "#e2e8f0",
  300: "#cbd5e1",
  400: "#94a3b8",
  500: "#64748b",
  600: "#475569",
  700: "#334155",
  800: "#1e293b",
  900: "#0f172a",
  950: "#020617",
} as const;

/**
 * Slate 400 and 500 carry most of the App's secondary text in both themes.
 * Tailwind's values fail AA for it — 400 on white is 2.56:1, 500 on slate-900
 * is 3.75:1 — so these two steps are theme-aware: darker in light mode,
 * lighter in dark mode. In each theme 400 stays the quieter of the two, and
 * both pass 4.5:1 on every surface that theme paints.
 */
export const THEME_SLATE = {
  light: { 400: "#5e6e84", 500: "#526177" },
  dark: { 400: "#94a3b8", 500: "#8391a7" },
} as const satisfies Record<ThemeName, { 400: string; 500: string }>;

/**
 * Steps nudged darker so text in them passes AA on white (Tailwind's
 * emerald-600 is 3.77:1, amber-600 3.19:1, sky-600 4.10:1). Each sits between
 * its own step and the next darker one, as light as AA allows, so the hue stays
 * recognisable — the warm hues land almost on their 700. `indigo-500`, the
 * accent's light step, moves a hair so white text on it and a focus ring drawn
 * in it pass too.
 */
export const AA_TUNED = {
  emerald: { 600: "#04805c" },
  amber: { 600: "#b55409" },
  sky: { 600: "#0276b4" },
  teal: { 600: "#0e7e74" },
  green: { 600: "#15813e" },
  orange: { 600: "#c6440c" },
  cyan: { 600: "#0d7a97" },
  lime: { 600: "#4d7d0f" },
  indigo: { 500: "#6163f0" },
} as const;

/** Tailwind's own values for the tuned steps, kept for the tests' before/after. */
export const TAILWIND_ORIGINAL = {
  emerald: { 600: "#059669" },
  amber: { 600: "#d97706" },
  sky: { 600: "#0284c7" },
  teal: { 600: "#0d9488" },
  green: { 600: "#16a34a" },
  orange: { 600: "#ea580c" },
  cyan: { 600: "#0891b2" },
  lime: { 600: "#65a30d" },
  indigo: { 500: "#6366f1" },
} as const;

/** The pale tint each tuned hue's chips sit on (its Tailwind 50 step). */
export const TINT_50 = {
  emerald: "#ecfdf5",
  amber: "#fffbeb",
  sky: "#f0f9ff",
  teal: "#f0fdfa",
  green: "#f0fdf4",
  orange: "#fff7ed",
  cyan: "#ecfeff",
  lime: "#f7fee7",
  indigo: "#eef2ff",
} as const;

/**
 * What each theme paints text on. Light: the slate-50 page, white cards,
 * slate-100 wells, hovers and chips, and the indigo-50 tint of whatever is
 * selected (the rail link you are on, a picked filter). Dark: the slate-950
 * page, slate-900 cards, slate-800 raised controls, and the selected tint —
 * indigo-500 at 15% over the page.
 */
export const SURFACES = {
  light: { page: SLATE[50], card: "#ffffff", sunken: SLATE[100], selected: "#eef2ff" },
  dark: { page: SLATE[950], card: SLATE[900], raised: SLATE[800], selected: "#101438" },
} as const satisfies Record<ThemeName, Record<string, string>>;

/**
 * Text roles, as the classes the App writes resolve in each theme:
 *
 *   strong     titles, values            text-slate-900 / dark:text-slate-100
 *   body       paragraphs, table cells   text-slate-700 / dark:text-slate-200
 *   secondary  supporting copy           text-slate-600 / dark:text-slate-300
 *   muted      meta lines, hints, labels text-slate-500 / dark:text-slate-400
 *   subtle     the quietest still-read   text-slate-400 / dark:text-slate-500
 */
export const TEXT = {
  light: {
    strong: SLATE[900],
    body: SLATE[700],
    secondary: SLATE[600],
    muted: THEME_SLATE.light[500],
    subtle: THEME_SLATE.light[400],
  },
  dark: {
    strong: SLATE[100],
    body: SLATE[200],
    secondary: SLATE[300],
    muted: THEME_SLATE.dark[400],
    subtle: THEME_SLATE.dark[500],
  },
} as const satisfies Record<ThemeName, Record<string, string>>;

/**
 * The one accent. `solid` fills primary buttons (white text on it), `text` is
 * links and active nav, `focus` draws every keyboard focus indicator — 3:1 or
 * better against every surface of its theme.
 */
export const ACCENT = {
  light: { solid: "#4f46e5", text: "#4f46e5", focus: "#4f46e5" },
  dark: { solid: "#4f46e5", text: "#818cf8", focus: "#818cf8" },
} as const satisfies Record<ThemeName, Record<string, string>>;

/** `#61718a` → `97 113 138`, the channel form Tailwind's `<alpha-value>` colours read. */
export function rgbChannels(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Expected a #rrggbb colour, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].join(" ");
}

/** The custom properties each theme sets on `<html>`. */
export function themeVariables(theme: ThemeName): Record<string, string> {
  return {
    "--gs-slate-400": rgbChannels(THEME_SLATE[theme][400]),
    "--gs-slate-500": rgbChannels(THEME_SLATE[theme][500]),
    "--gs-focus": rgbChannels(ACCENT[theme].focus),
  };
}

/** A Tailwind colour read from one of {@link themeVariables}, opacity modifiers included. */
export function themeColor(variable: keyof ReturnType<typeof themeVariables>): string {
  return `rgb(var(${variable}) / <alpha-value>)`;
}
