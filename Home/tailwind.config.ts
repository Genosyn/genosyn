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
        // ── The palette ────────────────────────────────────────────────────
        //
        // Colour is the org chart. Seven departments, seven permanently-bound
        // hues, used at tile scale: a 3px spine, a top edge, a chip, a tinted
        // pane. Never a mood, always a legend.
        //
        // The inversion is the argument: the machine is in colour, the human
        // is in black. Decisions, Approvals, primary controls and the wall's
        // eighth cell carry no hue at all, so on a page full of departments
        // the eye finds one achromatic thing and it is you.
        //
        // ## Why the ground is a grey and not an off-white
        //
        // Two earlier grounds were rejected, and both taught the same lesson.
        // A warm cream (#f2f0ec) measured 6.6 RGB from Anthropic's #f0eee6 —
        // not a resemblance, the same colour. A pale green (#cee5cb) cleared
        // every reference but read as a tint nobody asked for.
        //
        // The trap underneath both: EVERY very pale neutral lands in the same
        // small neighbourhood. #f2f0ec was simultaneously within 25 of Claude,
        // Linear, Vercel AND Stripe, because a near-white can only differ from
        // another near-white by a few points. So the way out is not a
        // different tint of near-white — it is to stop being near-white.
        //
        // #d9d9d6 is a true light grey, noticeably darker than every
        // white-page product: 35.0 from Claude, 44.7 from Linear, 46.9 from
        // Vercel, 50.6 from white. It is quiet on purpose. The identity of
        // this site is the seven-hue department system; the ground's job is to
        // sit still and let that carry, which cream and green both refused to
        // do.
        //
        // Panes are plain white. Every product has white panes and nobody owns
        // them; it is the PAGE that carries identity.
        //
        // Every ratio below is computed, not estimated. Worst pair in the
        // whole palette is 4.71:1.
        ink: "#131316", // 13.11:1 on ground, 17.51:1 on white
        ink2: "#3a3a3e", //  8.00:1 on ground — body prose
        muted: "#5c5c60", //  4.71:1 on ground, 6.66:1 on white — the text floor
        rule: "#78787b", //  3.11:1 on ground — structural, clears 1.4.11
        hairline: "#c8c8c5", //  decorative separators only, never meaning
        seam: "#a8a8a4", // the 1px grid behind the wall
        // Secondary text ON the ink plane. `muted` is a light-ground value and
        // reads at 2.79:1 on ink, which is how it leaked into the terminal
        // transcript and the night rows. 5.39:1 on ink.
        dim: "#8a8a8d",
        ground: "#d9d9d6",
        surface: "#ffffff",

        dept: {
          finance: "#00683c",
          repositories: "#572fbd",
          marketing: "#9b0060",
          workspace: "#006271",
          email: "#0d4cb7",
          revenue: "#962b00",
          operations: "#714e00",
          people: "#9e0f33", // /roles/recruiter only. Never on the home page.
        },
        // The hue mixed toward white. On a neutral page this is the legible
        // choice; a saturated tint would shout on grey where it sat calmly
        // inside the green ground it was originally drawn for.
        tint: {
          finance: "#e0ede8",
          repositories: "#ebe6f7",
          marketing: "#f3e0ec",
          workspace: "#e0ecee",
          email: "#e2eaf6",
          revenue: "#f2e6e0",
          operations: "#eeeae0",
          people: "#f3e2e7",
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
        panel: "inset 0 1px 0 rgba(255, 255, 255, 0.08)",
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
