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
        // ── HEADCOUNT ──────────────────────────────────────────────────────
        //
        // Colour is the org chart. Seven departments, seven hues, each one
        // permanently bound to a department and used at tile scale rather than
        // as an accent — a spine, a top edge, a chip, a whole tinted pane. It
        // is never a mood; it is a legend, and a reader decodes it in four
        // seconds.
        //
        // The inversion is the argument: the machine is in colour and the
        // human is in black. Every Decision, every Approval, the 09:30 arrival
        // and the primary button are `ink`, the one value with no hue at all.
        // So on a screen saturated with seven departments working at once, the
        // eye finds exactly one black thing, and it is you.
        //
        // Every ratio below is computed, not estimated. Worst case in the
        // whole set is 4.89:1 (Revenue on its own tint). Every hue passes AA
        // as text on white, on ground and on its own tint, and every hue
        // passes AA carrying white.
        ink: "#14120f", // 16.43:1 on ground, 18.70:1 on white
        ink2: "#3e3930", // 10.07:1 on ground — secondary prose
        muted: "#6b6459", // 5.14:1 on ground — mono labels, timestamps
        rule: "#8a8378", // 3.30:1 on ground — structural, clears 1.4.11
        hairline: "#dedad2", // 1.22:1 — decorative separators only
        seam: "#c9c3b8", // the 1px grid gaps behind the wall
        ground: "#f2f0ec",
        surface: "#ffffff",

        dept: {
          finance: "#0f6b45",
          repositories: "#5a2fc4",
          marketing: "#a8156b",
          workspace: "#0b6673",
          email: "#1450be",
          revenue: "#b03d0c",
          operations: "#7a5a0a",
          // Reserved for /roles/recruiter, which has no Board lane. Never on
          // the home page.
          people: "#b32540",
        },
        tint: {
          finance: "#dcefe4",
          repositories: "#e6e0fb",
          marketing: "#fbdeec",
          workspace: "#d9eef1",
          email: "#dee8fc",
          revenue: "#fbe4d8",
          operations: "#f2e9ce",
          people: "#fbdfe3",
        },
      },
      fontFamily: {
        // Bricolage Grotesque is display only. It is variable on opsz/wdth/wght,
        // so one download gives both the huge headline and the ultra-condensed
        // numerals, and its slightly irregular grotesque skeleton is the reason
        // it does not read as a framework default. Geist is excluded on purpose
        // — it is Vercel's face and would be a one-second tell.
        display: ["'Bricolage Grotesque'", "ui-sans-serif", "system-ui", "sans-serif"],
        // Everything that is a sentence, a label or a control, including all
        // text inside the product mocks.
        sans: ["'Instrument Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
        // Data the software emitted, and only that.
        mono: ["'Spline Sans Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      letterSpacing: {
        // The one tracked-out value, and it belongs to mono fields only.
        label: "0.16em",
        field: "0.1em",
      },
      borderRadius: {
        // v2's radius-0 read austere and was rejected; 8-12px everywhere is the
        // Linear tell. Split by what the thing is instead.
        none: "0",
        DEFAULT: "0",
        pane: "0", // wall panes, bands, bars — square, so 1px seams read as a grid
        control: "3px", // buttons, inputs — just enough to say "you can press this"
        chip: "2px",
        sm: "2px",
        md: "3px",
        lg: "3px",
        xl: "3px",
        "2xl": "3px",
        "3xl": "3px",
        full: "9999px", // avatars, status dots, the logo circle
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
