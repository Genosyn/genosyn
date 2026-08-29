import type { Config } from "tailwindcss";

/**
 * Genosyn marketing design tokens.
 *
 * The site is bright, warm and colourful on purpose. The claim is optimistic —
 * a company that keeps working on its own — and the palette has to sound like
 * that, not like a 3am server room. Three families carry it:
 *
 * - `paper`  the canvas. Warm off-whites, never a cold clinical grey. This is
 *            the single biggest reason the site no longer reads as flat.
 * - `flame`  the brand accent. Warm coral through tangerine. Dev tooling is a
 *            sea of indigo and slate, so warm reads as ours on sight.
 * - `night`  the punctuation. A violet-cast dark used for the one section that
 *            is literally about night, the terminal, and the closing panel.
 *            Violet-cast, not near-black, so the dark bands feel alive too.
 *
 * Text and hairlines use Tailwind `stone`, which is warm-neutral and sits on
 * paper without the blue cast slate drags in. Section and product colour comes
 * from the full Tailwind hue set — see products/data.ts, where every product
 * owns a hue.
 */
export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          50: "#fffdfa",
          100: "#fdf9f3",
          200: "#f8f2e8",
          300: "#f1e7d8",
          400: "#e5d8c4",
        },
        flame: {
          50: "#fff4ee",
          100: "#ffe4d6",
          200: "#ffc7aa",
          300: "#ffa275",
          400: "#ff7a45",
          500: "#f4551d",
          600: "#d93e0b",
          700: "#b22f08",
        },
        night: {
          950: "#0f0b1e",
          900: "#161029",
          850: "#1c1436",
          800: "#241a45",
          700: "#332658",
          600: "#463673",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "'JetBrains Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      letterSpacing: {
        // The one tracked-out value the whole site uses for mono eyebrows.
        label: "0.18em",
      },
      boxShadow: {
        // Warm-tinted, because a neutral-grey shadow on warm paper reads dirty.
        card: "0 1px 2px rgba(60, 40, 25, 0.05), 0 1px 1px rgba(60, 40, 25, 0.04)",
        lift: "0 14px 34px -14px rgba(60, 40, 25, 0.18), 0 3px 10px -3px rgba(60, 40, 25, 0.08)",
        raise: "0 28px 60px -26px rgba(60, 40, 25, 0.32), 0 6px 18px -8px rgba(60, 40, 25, 0.14)",
        float: "0 48px 96px -40px rgba(15, 11, 30, 0.55), 0 10px 28px -14px rgba(15, 11, 30, 0.3)",
        flame: "0 12px 32px -12px rgba(244, 85, 29, 0.45)",
        // Elevation on the dark bands is a lit top edge, not a drop shadow.
        panel: "inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.4)",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        halo: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(244, 85, 29, 0.45)" },
          "50%": { boxShadow: "0 0 0 7px rgba(244, 85, 29, 0)" },
        },
        sweep: {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(320%)" },
        },
        // Slow parallax on the hero wash, so the background is never quite still.
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(-2%, 1.5%, 0) scale(1.06)" },
        },
      },
      animation: {
        rise: "rise 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
        halo: "halo 2.4s ease-out infinite",
        sweep: "sweep 9s cubic-bezier(0.45, 0, 0.55, 1) infinite",
        drift: "drift 26s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
