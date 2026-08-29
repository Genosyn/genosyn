import type { ReactNode } from "react";
import { Link } from "@/lib/router";

/**
 * The marketing design kit.
 *
 * Every marketing page — landing, products, product detail, pricing,
 * enterprise — composes these. The rule this file exists to enforce is that a
 * section never invents its own surface, eyebrow, heading ramp, or button
 * skin: those drifted across six files before, which is how the site ended up
 * with four heading ramps and three secondary-button shadows.
 *
 * Colour is deliberate here, not decorative. The old site was monochrome slate
 * from top to bottom and read as flat; the palette in tailwind.config.ts gives
 * the page warm paper, one branded accent, and a violet-cast dark for the
 * bands that punctuate it.
 */

/* -------------------------------------------------------------------------
   Surfaces
------------------------------------------------------------------------- */

export type SectionTone = "paper" | "tint" | "night";

const SECTION_TONE: Record<SectionTone, string> = {
  paper: "bg-paper-50 text-stone-700",
  tint: "bg-paper-200 text-stone-700",
  night: "on-night bg-night-950 text-violet-100/70",
};

const SECTION_DIVIDE: Record<SectionTone, string> = {
  paper: "border-t border-stone-900/[0.07]",
  tint: "border-t border-stone-900/[0.07]",
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

/** A card on paper. Interactive cards get `hover`. */
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
      className={`rounded-2xl border border-stone-900/[0.07] bg-white shadow-card ${
        hover
          ? "transition duration-200 hover:-translate-y-1 hover:border-stone-900/[0.12] hover:shadow-lift"
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
 * Section eyebrow.
 *
 * This used to be a tracked-out uppercase monospace label with a section index
 * in front of it. Between that, the grid overlay and the gradient headline the
 * page read as a zine rather than a product site, so the eyebrow is now plain
 * sentence-case sans in the accent colour — the label is there to orient, not
 * to decorate.
 */
export function Eyebrow({ night = false, children }: { night?: boolean; children: ReactNode }) {
  return (
    <div
      className={`inline-flex items-center gap-2.5 text-sm font-semibold ${
        night ? "text-flame-300" : "text-flame-600"
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${night ? "bg-flame-300" : "bg-flame-500"}`}
      />
      <span>{children}</span>
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
  className = "",
  children,
}: {
  as?: "h1" | "h2";
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={`text-balance text-[clamp(2.5rem,6vw,4.5rem)] font-semibold leading-[0.98] tracking-[-0.045em] ${
        night ? "text-white" : "text-stone-900"
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
        night ? "text-white" : "text-stone-900"
      } ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * The accent half of a two-tone headline, used once per page at most, on the
 * words the page is actually about. Solid, not a gradient: gradient headlines
 * date a site faster than anything else on it.
 */
export function Accent({ children }: { children: ReactNode }) {
  return <span className="text-flame-500">{children}</span>;
}

/** The muted half of a two-tone headline. */
export function Muted({ night = false, children }: { night?: boolean; children: ReactNode }) {
  return <span className={night ? "text-violet-200/60" : "text-stone-400"}>{children}</span>;
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
        night ? "text-violet-100/70" : "text-stone-600"
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
    <p className={`text-base leading-7 ${night ? "text-violet-100/60" : "text-stone-600"} ${className}`}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------
   Controls
------------------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "night" | "ghost";

const BUTTON_SKIN: Record<ButtonVariant, string> = {
  // Flat accent fill with a restrained shadow. The gradient-plus-glow version
  // this replaced shouted louder than anything it sat next to.
  primary: "bg-flame-500 text-white shadow-card hover:bg-flame-600",
  secondary:
    "border border-stone-900/[0.10] bg-white text-stone-800 shadow-card hover:border-stone-900/20 hover:bg-paper-50",
  night: "border border-white/20 bg-white/[0.07] text-white hover:border-white/35 hover:bg-white/[0.14]",
  ghost: "text-stone-500 hover:text-stone-900",
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
  const classes = `group inline-flex items-center gap-2 text-sm font-semibold transition ${
    night ? "text-white hover:text-flame-300" : "text-stone-900 hover:text-flame-600"
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

export type PillTone = "neutral" | "live" | "waiting" | "flame" | "violet";

/** Status pill. `tone` maps to the site-wide state colours. */
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
    neutral: "border-stone-900/[0.08] bg-white text-stone-600",
    live: "border-emerald-500/25 bg-emerald-50 text-emerald-700",
    waiting: "border-amber-500/30 bg-amber-50 text-amber-700",
    flame: "border-flame-300 bg-flame-50 text-flame-700",
    violet: "border-violet-300 bg-violet-50 text-violet-700",
  };
  const dark: Record<PillTone, string> = {
    neutral: "border-white/12 bg-white/[0.06] text-violet-100/80",
    live: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    waiting: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    flame: "border-flame-400/35 bg-flame-400/12 text-flame-200",
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
  const line = night ? "bg-white/[0.12]" : "bg-stone-900/[0.10]";
  if (!label) return <span aria-hidden className={`block h-px w-full ${line}`} />;
  return (
    <div className="flex items-center gap-4">
      <h2
        className={`text-sm font-semibold ${night ? "text-violet-100/80" : "text-stone-900"}`}
      >
        {label}
      </h2>
      <span aria-hidden className={`h-px flex-1 ${line}`} />
      {count && (
        <span className={`text-xs ${night ? "text-violet-200/50" : "text-stone-400"}`}>
          {count}
        </span>
      )}
    </div>
  );
}
