import type { Config } from "tailwindcss";

/**
 * Genosyn marketing design tokens.
 *
 * The site is black, white and grey, and it earns its life from contrast and
 * structure rather than from a brand hue. Three families carry it:
 *
 * - `paper`  the canvas. Pure white through to a light grey band, so sections
 *            alternate white / near-white / white / grey and the page has a
 *            rhythm you can feel while scrolling.
 * - `ink`    emphasis. A neutral ramp, deliberately not a hue — it fills the
 *            buttons, paints the dark bands' bright text, and marks the words
 *            the page is about.
 * - `night`  the punctuation. Near-black bands for the sections that are
 *            literally about the night shift, the terminal, and the close.
 *
 * Text and hairlines use Tailwind `zinc` — a clean, very slightly cool
 * neutral that sits on white without the brown cast `stone` drags in.
 *
 * ## Why `ink` is not a lightness ramp
 *
 * This accent was a hue (rose) before, and the argument for it was that a
 * neutral accent has to go *lighter* than the near-black headings to be
 * distinguishable from them, and a lighter word reads as de-emphasis. That
 * argument is sound, and the fix is not a different grey — it is to stop
 * asking a neutral to be the loud half of a two-tone headline. Emphasis on
 * this site is carried by weight and darkness: the payoff half of a headline
 * is `zinc-950`, and the setup half is the grey. `Accent` and `Muted` in
 * sections/Kit.tsx implement exactly that inversion.
 *
 * So `ink` is compressed on purpose. 50–400 are the quiet half — tile fills,
 * hairlines, separator dots, and the light text that sits on a dark band.
 * 500–900 are the loud half — near-black fills and the words that have to
 * out-shout a heading. The gap between 400 and 500 is the point: there is no
 * mid-grey step, because a mid-grey is exactly the value that reads as
 * "disabled" wherever emphasis was intended.
 *
 * ## Where colour lives
 *
 * Colour did not leave the site; it stopped being decoration. Every hue is
 * now load-bearing and small: emerald means running, amber means waiting for
 * a human, rose means something broke, and each role (roles/data.ts) and
 * product (products/data.ts) owns one hue that repeats across its icon tile,
 * its dot on a timeline, and its card. A screen should be able to hold twenty
 * of them without the page reading as coloured — that ratio is the design.
 */
export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          50: "#ffffff",
          100: "#fafafa",
          200: "#f4f4f5",
          300: "#ebebed",
          400: "#dcdce0",
        },
        ink: {
          50: "#f7f7f8",
          100: "#eeeef0",
          200: "#dcdce0",
          300: "#b9b9c0",
          400: "#8e8e97",
          // ── the loud half ──
          500: "#2f2f35",
          600: "#1c1c20",
          700: "#131316",
          800: "#0e0e11",
          900: "#08080a",
        },
        night: {
          950: "#0b0b0d",
          900: "#131316",
          850: "#191920",
          800: "#202028",
          700: "#2b2b33",
          600: "#3d3d47",
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
        label: "0.14em",
      },
      boxShadow: {
        // Neutral and shallow. On a white page the hairline does most of the
        // separating; the shadow only has to lift a card off the grey bands.
        card: "0 1px 2px rgba(9, 9, 11, 0.05), 0 1px 1px rgba(9, 9, 11, 0.04)",
        lift: "0 14px 34px -14px rgba(9, 9, 11, 0.16), 0 3px 10px -3px rgba(9, 9, 11, 0.07)",
        raise: "0 28px 60px -26px rgba(9, 9, 11, 0.28), 0 6px 18px -8px rgba(9, 9, 11, 0.12)",
        float: "0 48px 96px -40px rgba(9, 9, 11, 0.5), 0 10px 28px -14px rgba(9, 9, 11, 0.3)",
        // Elevation on the dark bands is a lit top edge, not a drop shadow.
        panel: "inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.4)",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
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
        sweep: "sweep 9s cubic-bezier(0.45, 0, 0.55, 1) infinite",
        drift: "drift 26s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
