import type { Config } from "tailwindcss";

/**
 * Genosyn marketing design tokens — "Night Board".
 *
 * The site is an operations board for last night. Left-to-right is time, a
 * bar's width is a duration, a rule is a boundary, and colour is reserved for
 * the one row that needs a person. Everything below serves that.
 *
 * ## The neutrals are warm, and `zinc` is the ramp
 *
 * `zinc` is redefined here rather than shadowed by a new family. The whole
 * site — marketing sections, product and role pages, and 57 docs pages —
 * already uses `zinc` as "the neutral ramp", so remapping it is what repaints
 * every surface at once instead of leaving a cool-grey docs section behind a
 * warm marketing site. The ramp is warm (a yellow-leaning neutral, not
 * Tailwind's cool grey) so the page reads as printed strip stock rather than
 * as a framework default. That difference is most of why the site no longer
 * looks stamped out of the same tin as every other one.
 *
 * Measured against `#F4F3EF` (paper), computed not estimated:
 *
 *   200 #DAD7CE  1.30:1  hairline. Decorative separation only, never meaning.
 *   400 #8C8880  3.18:1  structural rule. Clears WCAG 1.4.11 because the rail
 *                        carries meaning and therefore has to be visible.
 *   600 #65625A  5.49:1  the quiet floor. Nothing lighter may carry text.
 *   700 #56544C  6.83:1  body.
 *   950 #111110 17.02:1  the one black — headings, fills and rules alike.
 *
 * On night (`#0B0B0A`): 300 is 10.72:1, 400 is 5.58:1. Those are the two
 * values that may carry text there; 500 and below may not.
 *
 * ## `signal` is the only hue, and it means one thing
 *
 * `#FFB000` is amber phosphor — a VT220 / IBM 3278 referent an operations
 * audience reads as instrumentation. It marks the human boundary and nothing
 * else: the 09:30 arrival line, Decisions, Approvals.
 *
 * Its usage rule is an accessibility rule rather than a taste one. Amber on
 * paper is 1.65:1, so on light ground it is only ever a *fill* with ink on it
 * (10.31:1) or a 2px rule — never text. On night it inverts and becomes a
 * text colour (10.75:1). The focus ring is deliberately not amber for the
 * same reason.
 *
 * A Standdown gets no hue at all. It is drawn as a 45° hatch (`.hatch` in
 * index.css) — the instrument convention for out-of-service — which keeps the
 * "one colour, one meaning" rule intact instead of spending a second hue.
 *
 * ## What is absent, and why
 *
 * There is no radius above 2px and there are no drop shadows. Both were doing
 * the same job — making a rectangle look like a floating card — and cards are
 * not a category on this site: a set of things is a stack of rules-separated
 * rows, not a grid of bordered boxes. `panel` survives alone because a lit top
 * edge is how elevation actually reads on a dark plane.
 *
 * `borderRadius.full` stays at 9999px on purpose. Flattening it would also
 * flatten the avatars and status dots inside the product mocks, which are
 * pictures of a real UI and are meant to keep their own shapes.
 */
export default {
  content: ["./client/index.html", "./client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // The neutral ramp. Warm, and deliberately the `zinc` key so every
        // existing call site across the site and docs is repainted at once.
        zinc: {
          50: "#fbfaf7",
          100: "#f4f3ef",
          200: "#dad7ce",
          300: "#c3bfb4",
          400: "#8c8880",
          500: "#77746b",
          600: "#65625a",
          700: "#56544c",
          800: "#33322d",
          900: "#1a1a18",
          950: "#111110",
        },
        paper: {
          50: "#fbfaf7", // raised — the board, and the one lighter surface
          100: "#f4f3ef", // ground
          200: "#eceae3", // recessed — what a plate is mounted on
          300: "#dad7ce", // hairline
          400: "#8c8880", // structural rule
        },
        ink: {
          // ── the quiet half ──
          50: "#f4f3ef",
          100: "#eceae3",
          200: "#dad7ce",
          300: "#8c8880",
          400: "#65625a",
          // ── the loud half ──
          // The gap between 400 and 500 is kept from the previous token file
          // and is still the point: there is no mid-grey step, because a
          // mid-grey is exactly the value that reads as "disabled" wherever
          // emphasis was intended.
          500: "#56544c",
          600: "#33322d",
          700: "#232320",
          800: "#1a1a18",
          900: "#111110",
        },
        night: {
          950: "#0b0b0a", // the dark plane
          900: "#111110",
          850: "#161614", // raised on night
          800: "#1e1e1b",
          700: "#2a2a26", // hairline on night
          600: "#6a665c", // structural rule on night — 3.44:1
        },
        signal: {
          // The human boundary. Never text on paper.
          DEFAULT: "#ffb000",
          400: "#ffc23d",
          500: "#ffb000",
          600: "#d99500",
        },
      },
      fontFamily: {
        // One superfamily carries display and prose, separated by WIDTH rather
        // than weight (see `.t-display` / `.t-cond` in index.css). Archivo is a
        // two-axis variable face; a wide engineered grotesque reads as an
        // instrument fascia, which Inter never does.
        sans: [
          "Archivo",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        // The data face. Timestamps, Run refs, counts, state labels — strings
        // the software actually emitted. Never flavour on a sentence.
        mono: [
          "'Martian Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        // The second voice, and the only one with a different skeleton: an
        // italic serif for figure captions, margin notes and the colophon.
        // A width axis alone is one voice squashed, not two.
        note: ["Newsreader", "ui-serif", "Georgia", "serif"],
      },
      letterSpacing: {
        // The one tracked-out value, and it belongs to mono fields only.
        label: "0.16em",
        field: "0.1em",
      },
      borderRadius: {
        none: "0",
        DEFAULT: "0",
        sm: "2px",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        "3xl": "0",
        // Kept: the product mocks contain real circles (avatars, status dots)
        // and flattening those would break pictures of a working UI.
        full: "9999px",
      },
      boxShadow: {
        // The card shadows are gone because cards are gone. These four keys
        // stay defined as `none` so the ~79 existing call sites collapse
        // without a sweep, and can be deleted incrementally.
        card: "none",
        lift: "none",
        raise: "none",
        float: "none",
        // Elevation on a dark plane is a lit top edge, not a drop shadow.
        panel: "inset 0 1px 0 rgba(251, 250, 247, 0.08)",
      },
      keyframes: {
        // The one animation on the site, and it is the argument: bars draw
        // left to right, so the night fills in before you arrive.
        strip: {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        arrive: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // A boundary being drawn, not an object appearing.
        wipe: {
          from: { transform: "scaleY(0)" },
          to: { transform: "scaleY(1)" },
        },
      },
      animation: {
        strip: "strip 520ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
        arrive: "arrive 400ms 900ms linear both",
        wipe: "wipe 160ms linear both",
      },
    },
  },
  plugins: [],
} satisfies Config;
