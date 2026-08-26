import type { Config } from "tailwindcss";

export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
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
  plugins: [],
} satisfies Config;
