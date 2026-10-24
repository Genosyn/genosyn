import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";
import plugin from "tailwindcss/plugin";
import { AA_TUNED, themeColor, themeVariables } from "./client/lib/designTokens";

/**
 * Tailwind's palette with the App's few AA adjustments (client/lib/designTokens.ts):
 * slate 400/500 follow the theme through CSS variables, and the steps in
 * `AA_TUNED` are nudged so text in them passes 4.5:1 on white.
 */
const palette = {
  slate: {
    ...colors.slate,
    400: themeColor("--gs-slate-400"),
    500: themeColor("--gs-slate-500"),
  },
  ...Object.fromEntries(
    Object.entries(AA_TUNED).map(([hue, steps]) => [
      hue,
      { ...(colors as unknown as Record<string, Record<string, string>>)[hue], ...steps },
    ]),
  ),
};

export default {
  content: ["./client/index.html", "./client/careers.html", "./client/**/*.{ts,tsx}"],
  darkMode: "class",
  // Tailwind drops a base rule whose selector names a class it never saw in
  // the content; the dark theme's variables hang off `.dark`, which only
  // script adds to <html>.
  safelist: ["dark"],
  theme: {
    extend: {
      colors: {
        ...palette,
        // The keyboard focus colour: indigo-600 on light surfaces, indigo-400
        // on dark ones — 3:1 or better against everything it is drawn on.
        focus: themeColor("--gs-focus"),
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      // Modal entrance. Short enough to feel like the panel was already there
      // and quiet enough not to be a performance; the scrim settles first so
      // the card lands on steady ground. Surfaces pair these with
      // `motion-reduce:animate-none`.
      keyframes: {
        "scrim-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "panel-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "scrim-in": "scrim-in 120ms ease-out",
        "panel-in": "panel-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root": themeVariables("light"),
        ":root.dark": themeVariables("dark"),
      });
    }),
  ],
} satisfies Config;
