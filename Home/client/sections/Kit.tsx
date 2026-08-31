import type { ReactNode } from "react";
import { Link } from "@/lib/router";

/**
 * The marketing design kit.
 *
 * Every marketing page — landing, roles, role detail, products, product
 * detail, pricing, enterprise — composes these. The rule this file exists to
 * enforce is that a section never invents its own surface, eyebrow, heading
 * ramp, or button skin: those drifted across six files before, which is how
 * the site ended up with four heading ramps and three secondary-button
 * shadows.
 *
 * The palette is black, white and grey (see tailwind.config.ts). Emphasis is
 * carried by darkness and weight, never by a brand hue: the loud half of a
 * two-tone headline is `Accent` (near-black) and the quiet half is `Muted`
 * (grey). Getting that the wrong way round is the one mistake that makes a
 * neutral palette read as flat, because a lighter word always reads as
 * de-emphasis no matter what the designer intended by it.
 */

/* -------------------------------------------------------------------------
   Surfaces
------------------------------------------------------------------------- */

export type SectionTone = "paper" | "tint" | "night";

const SECTION_TONE: Record<SectionTone, string> = {
  paper: "bg-white text-zinc-800",
  tint: "bg-paper-200 text-zinc-800",
  night: "on-night bg-night-950 text-zinc-400",
};

const SECTION_DIVIDE: Record<SectionTone, string> = {
  paper: "border-t border-zinc-200",
  tint: "border-t border-zinc-200",
  night: "",
};

/**
 * A full-bleed band. `divide` draws the hairline that separates one band from
 * the next; the dark bands need no rule because the colour change is the rule.
 */
export function Section({
  id,
  tone = "paper",
  divide = true,
  className = "",
  children,
}: {
  id?: string;
  tone?: SectionTone;
  divide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative isolate overflow-hidden ${SECTION_TONE[tone]} ${
        divide ? SECTION_DIVIDE[tone] : ""
      } ${className}`}
    >
      {children}
    </section>
  );
}

/** The one container width for the whole site, and the one vertical rhythm. */
export function Container({
  wide = false,
  flush = false,
  className = "",
  children,
}: {
  wide?: boolean;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative z-10 mx-auto w-full px-5 sm:px-8 ${
        wide ? "max-w-[88rem]" : "max-w-7xl"
      } ${flush ? "" : "py-20 sm:py-24 lg:py-32"} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A card on paper. Interactive cards get `hover`.
 *
 * The border is a real `zinc-200` hairline rather than a black at 7% alpha.
 * On a white page a card and its band are the same colour, so the border is
 * the only thing drawing the card at all — it has to be visible.
 */
export function Panel({
  hover = false,
  className = "",
  children,
}: {
  hover?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-zinc-200 bg-white shadow-card ${
        hover
          ? "transition duration-200 hover:-translate-y-1 hover:border-zinc-300 hover:shadow-lift"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** The same card on a dark band. */
export function NightPanel({
  hover = false,
  className = "",
  children,
}: {
  hover?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.10] bg-white/[0.04] shadow-panel ${
        hover
          ? "transition duration-200 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.08]"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Type
------------------------------------------------------------------------- */

/**
 * Section eyebrow — a tracked-out uppercase label that names the band.
 *
 * It is grey, not coloured, and it is the only uppercase text on the site.
 * That combination is what lets it orient a reader without competing with the
 * heading two lines below it: uppercase reads as a label wherever it appears,
 * so the eyebrow does not need colour to be legible as one.
 */
export function Eyebrow({ night = false, children }: { night?: boolean; children: ReactNode }) {
  return (
    <div
      className={`text-[11px] font-semibold uppercase tracking-label ${
        night ? "text-zinc-400" : "text-zinc-700"
      }`}
    >
      {children}
    </div>
  );
}

/**
 * The one headline ramp. `clamp` carries it from phones to 1440px without a
 * breakpoint step, and the negative tracking tightens as it grows so the large
 * sizes do not read airy.
 */
export function Display({
  as: Tag = "h1",
  night = false,
  /**
   * `text-balance` evens the line lengths, which is right for most headlines
   * but wrong for a two-tone one: it can orphan a word onto the second line
   * and split the accent mid-line. Pass false to wrap greedily so the break
   * falls at the accent instead.
   */
  balance = true,
  className = "",
  children,
}: {
  as?: "h1" | "h2";
  night?: boolean;
  balance?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={`${balance ? "text-balance" : ""} text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[0.98] tracking-[-0.045em] ${
        night ? "text-white" : "text-zinc-950"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

/** Section headings — one step down from Display. */
export function Heading({
  as: Tag = "h2",
  night = false,
  className = "",
  children,
}: {
  as?: "h2" | "h3";
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={`text-balance text-[clamp(1.875rem,3.4vw,2.875rem)] font-semibold leading-[1.06] tracking-[-0.035em] ${
        night ? "text-white" : "text-zinc-950"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * The loud half of a two-tone headline, used once per page at most, on the
 * words the page is actually about.
 *
 * It is the darkest value on the page, and `Muted` — grey — carries the
 * setup around it. That inversion is deliberate and it is the whole reason a
 * neutral palette can hold a two-tone headline at all: a grey accent against
 * a black heading has to go lighter to be distinguishable, and a lighter word
 * reads as de-emphasis. Darker never does.
 */
export function Accent({ children }: { children: ReactNode }) {
  return <span className="text-zinc-950">{children}</span>;
}

/**
 * The quiet half of a two-tone headline.
 *
 * zinc-700 on light — the same value as body copy, which is deliberate. At
 * 96px the quiet half of a headline is the largest area of grey anywhere on
 * the site, so it is what decides whether the palette reads as black-and-white
 * or merely as grey. Every lighter value was wrong twice over: zinc-400 on
 * white is 2.6:1, under the 3:1 floor WCAG 1.4.3 sets even for large type, and
 * anything through zinc-600 still reads washed at display size. Against a
 * zinc-950 payoff this is a tonal shift rather than a colour change, which is
 * the whole effect being aimed at.
 */
export function Muted({ night = false, children }: { night?: boolean; children: ReactNode }) {
  return <span className={night ? "text-zinc-400" : "text-zinc-700"}>{children}</span>;
}

export function Lede({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={`text-pretty text-lg leading-8 sm:text-xl sm:leading-9 ${
        night ? "text-zinc-400" : "text-zinc-700"
      } ${className}`}
    >
      {children}
    </p>
  );
}

export function Body({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={`text-base leading-7 ${night ? "text-zinc-400" : "text-zinc-700"} ${className}`}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------
   Controls
------------------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "night" | "ghost";

const BUTTON_SKIN: Record<ButtonVariant, string> = {
  // Near-black fill. On a black-and-white page the primary action is the
  // darkest thing on screen, which is both the loudest it can be and the
  // cheapest kind of loud — no hue to clash with the twenty small ones the
  // product mocks carry.
  primary: "bg-ink-900 text-white shadow-card hover:bg-ink-600",
  secondary: "border border-zinc-300 bg-white text-zinc-950 shadow-card hover:border-zinc-400 hover:bg-paper-100",
  night: "bg-white text-zinc-950 hover:bg-zinc-200",
  ghost: "text-zinc-600 hover:text-zinc-950",
};

export function Button({
  href,
  external,
  variant = "primary",
  block = false,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  variant?: ButtonVariant;
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const shape =
    variant === "ghost"
      ? "px-3 py-3"
      : `px-5 py-3.5 ${block ? "w-full" : "w-full sm:w-auto"} hover:-translate-y-0.5`;
  const classes = `inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition duration-200 ${shape} ${BUTTON_SKIN[variant]} ${className}`;

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }

  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

/** A text link that reads as the section's next step. */
export function TextLink({
  href,
  external,
  night = false,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `group inline-flex items-center gap-2 border-b pb-1 text-sm font-semibold transition ${
    night
      ? "border-white/25 text-white hover:border-white"
      : "border-zinc-300 text-zinc-950 hover:border-zinc-900"
  } ${className}`;
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------
   Fragments
------------------------------------------------------------------------- */

export type PillTone = "neutral" | "live" | "waiting" | "ink" | "violet";

/**
 * Status pill. `tone` maps to the site-wide state colours, and those are the
 * only place a hue means something on its own: emerald is running, amber is
 * waiting for a human.
 */
export function Pill({
  tone = "neutral",
  night = false,
  className = "",
  children,
}: {
  tone?: PillTone;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const light: Record<PillTone, string> = {
    neutral: "border-zinc-200 bg-white text-zinc-700",
    live: "border-emerald-500/25 bg-emerald-50 text-emerald-700",
    waiting: "border-amber-500/30 bg-amber-50 text-amber-700",
    ink: "border-zinc-300 bg-zinc-100 text-zinc-900",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
  };
  const dark: Record<PillTone, string> = {
    neutral: "border-white/12 bg-white/[0.06] text-zinc-300",
    live: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    waiting: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    ink: "border-white/20 bg-white/[0.12] text-white",
    violet: "border-violet-400/35 bg-violet-400/12 text-violet-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
        night ? dark[tone] : light[tone]
      } ${className}`}
    >
      {children}
    </span>
  );
}

/** The pulsing dot that means "this is happening right now". */
export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`preview-live inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 ${className}`}
    />
  );
}

/** A hairline rule with a label sitting on it, used to head a card grid. */
export function Rule({
  label,
  count,
  night = false,
}: {
  label?: string;
  count?: string;
  night?: boolean;
}) {
  const line = night ? "bg-white/[0.12]" : "bg-zinc-200";
  if (!label) return <span aria-hidden className={`block h-px w-full ${line}`} />;
  return (
    <div className="flex items-center gap-4">
      <h2
        className={`text-[11px] font-semibold uppercase tracking-label ${
          night ? "text-zinc-400" : "text-zinc-700"
        }`}
      >
        {label}
      </h2>
      <span aria-hidden className={`h-px flex-1 ${line}`} />
      {count && (
        <span className={`text-xs ${night ? "text-zinc-400" : "text-zinc-600"}`}>{count}</span>
      )}
    </div>
  );
}
