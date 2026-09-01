import type { ReactNode } from "react";
import { Link } from "@/lib/router";

/**
 * The marketing design kit — HEADCOUNT.
 *
 * Colour is the org chart. Seven departments, seven hues, each permanently
 * bound to a department and used at tile scale rather than as an accent. It is
 * never a mood; it is a legend, and a reader decodes it in four seconds.
 *
 * The inversion is the argument: **the machine is in colour, the human is in
 * black.** Every Decision, every Approval and every primary control is `ink`,
 * the one value with no hue at all. So on a page saturated with seven
 * departments working at once, the eye finds exactly one black thing, and it
 * is you.
 *
 * Three rules follow from that and they are the whole system:
 *
 * 1. **A hue only ever means its department.** Never a mood, never emphasis,
 *    never decoration. A heading is never coloured; an icon is never coloured.
 * 2. **The human states carry no hue.** If it needs a person, it is ink.
 * 3. **Density is the argument.** The product's claim is that a lot happens at
 *    once, so whitespace is spent sparingly and tiles meet on 1px seams. A
 *    generous, airy page would be a prettier lie.
 *
 * Every ratio in the token file is computed, not estimated. The worst pair in
 * the whole palette is 4.89:1.
 */

/* -------------------------------------------------------------------------
   Departments
------------------------------------------------------------------------- */

export type Dept =
  | "finance"
  | "repositories"
  | "marketing"
  | "workspace"
  | "email"
  | "revenue"
  | "operations"
  | "people";

/** Full hue: fills, spines, chips, department names set as text. */
export const DEPT_FULL: Record<Dept, string> = {
  finance: "bg-dept-finance",
  repositories: "bg-dept-repositories",
  marketing: "bg-dept-marketing",
  workspace: "bg-dept-workspace",
  email: "bg-dept-email",
  revenue: "bg-dept-revenue",
  operations: "bg-dept-operations",
  people: "bg-dept-people",
};

/** Tint: hover grounds, selected rows, band backgrounds. */
export const DEPT_TINT: Record<Dept, string> = {
  finance: "bg-tint-finance",
  repositories: "bg-tint-repositories",
  marketing: "bg-tint-marketing",
  workspace: "bg-tint-workspace",
  email: "bg-tint-email",
  revenue: "bg-tint-revenue",
  operations: "bg-tint-operations",
  people: "bg-tint-people",
};

export const DEPT_TEXT: Record<Dept, string> = {
  finance: "text-dept-finance",
  repositories: "text-dept-repositories",
  marketing: "text-dept-marketing",
  workspace: "text-dept-workspace",
  email: "text-dept-email",
  revenue: "text-dept-revenue",
  operations: "text-dept-operations",
  people: "text-dept-people",
};

/** A department chip. White on any full hue is 5.97:1 or better. */
export function Chip({
  dept,
  className = "",
  children,
}: {
  dept: Dept;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`t-field rounded-chip inline-block px-2 py-1 leading-none text-surface ${DEPT_FULL[dept]} ${className}`}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------
   Surfaces
------------------------------------------------------------------------- */

export type BandTone = "ground" | "surface" | "ink";

const BAND_TONE: Record<BandTone, string> = {
  ground: "bg-ground text-ink2",
  surface: "bg-surface text-ink2",
  // `text-ground`, not `text-ink`. The mechanical token swap mapped the old
  // light value onto `ink` here, which set an ink band's default text to the
  // same value as its own fill — 1.00:1, the whole band blank. Nothing renders
  // `tone="ink"` today, so it was invisible in review as well as on screen.
  ink: "bg-ink text-ground",
};

export type BandPad = "xs" | "s" | "m" | "l" | "none";

/**
 * Vertical rhythm. A band declares how much air it opens with and closes with,
 * independently, so a seam is one decision rather than the sum of two.
 */
const BAND_OPEN: Record<BandPad, string> = {
  none: "",
  xs: "pt-8 sm:pt-10",
  s: "pt-10 sm:pt-14",
  m: "pt-14 sm:pt-16 lg:pt-[5.5rem]",
  l: "pt-16 sm:pt-24 lg:pt-[7.5rem]",
};

const BAND_CLOSE: Record<BandPad, string> = {
  none: "",
  xs: "pb-6",
  s: "pb-8 sm:pb-10",
  m: "pb-12 sm:pb-14 lg:pb-[4.5rem]",
  l: "pb-14 sm:pb-20 lg:pb-24",
};

export function Band({
  id,
  tone = "ground",
  pad = "m",
  open,
  close,
  rule = true,
  className = "",
  children,
}: {
  id?: string;
  tone?: BandTone;
  pad?: BandPad;
  open?: BandPad;
  close?: BandPad;
  rule?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative ${BAND_TONE[tone]} ${
        rule && tone !== "ink" ? "border-t border-hairline" : ""
      } ${className}`}
    >
      <div className={`${BAND_OPEN[open ?? pad]} ${BAND_CLOSE[close ?? pad]}`}>{children}</div>
    </section>
  );
}

/** The one container. 90rem, so the wall has somewhere to be wide. */
export function Container({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full max-w-[90rem] px-5 sm:px-8 lg:px-12 ${className}`}>
      {children}
    </div>
  );
}

/**
 * A band head: an eyebrow, a heading and an optional lede, in a two-column
 * grid so the heading and its explanation sit side by side rather than
 * stacking into a narrow column with a dead right half.
 */
export function Head({
  eyebrow,
  title,
  lede,
  aside,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {eyebrow && <div className="t-field mb-4 text-muted">{eyebrow}</div>}
      <div className="grid gap-x-16 gap-y-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <h2 className="t-h2 max-w-[26ch] text-[clamp(1.875rem,3.4vw,3.25rem)] text-ink">{title}</h2>
        {(lede || aside) && (
          <div className="lg:pt-2">
            {lede && (
              <p className="max-w-[58ch] text-[1.0625rem] leading-[1.55] text-ink2">{lede}</p>
            )}
            {aside && <div className="mt-5">{aside}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * `Rail` — the migration shim, and deliberately not a rail any more.
 *
 * The previous design was built on a 9.5rem gutter carrying a sheet number and
 * mono fields, with a continuous vertical rule down the document. HEADCOUNT
 * has no gutter: the page is tiled, not ruled, and a spine down the left would
 * fight the 1px seams the wall is built on.
 *
 * Twenty files still call this, so rather than run a risky JSX codemod across
 * all of them it renders the HEADCOUNT way — the sheet becomes an eyebrow, the
 * fields become a mono line beside it, and the gutter simply does not exist.
 * New code should use `Head` instead.
 */
export function Rail({
  sheet,
  fields,
  margin,
  head,
  className = "",
  children,
}: {
  sheet?: string;
  fields?: string[];
  margin?: ReactNode;
  head?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {(sheet || fields?.length) && (
        <div className="mb-6 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {sheet && <span className="t-field text-muted">{sheet}</span>}
          {fields?.map((field) => (
            <span key={field} className="t-data text-[11px] text-muted">
              {field}
            </span>
          ))}
        </div>
      )}
      {head}
      {children}
      {margin && <div className="mt-10 border-t border-hairline pt-6">{margin}</div>}
    </div>
  );
}

/**
 * A product surface. Everything that is a picture of the application is
 * mounted this way: white, a 1px pane border, a 3px department edge, no
 * shadow. Nothing on this site floats.
 */
export function Pane({
  dept,
  title,
  meta,
  className = "",
  children,
}: {
  dept?: Dept;
  title?: string;
  meta?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`relative border border-hairline bg-surface ${className}`}>
      {dept && (
        <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] ${DEPT_FULL[dept]}`} />
      )}
      {(title || meta) && (
        <div className="flex items-baseline justify-between gap-3 border-b border-hairline px-4 pt-5 pb-3">
          {title && <span className="t-h3 truncate text-[15px] text-ink">{title}</span>}
          {meta && <span className="t-data shrink-0 text-[11px] text-muted">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** A figure: a pane with a numbered caption. */
export function Plate({
  figure,
  caption,
  className = "",
  children,
}: {
  figure: string;
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={className}>
      <div className="border border-hairline bg-surface">{children}</div>
      <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-3">
        <span className="t-field text-muted">{figure}</span>
        <span className="text-[14px] italic leading-6 text-ink2">{caption}</span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   Type
------------------------------------------------------------------------- */

/**
 * Headlines carry a number, a clock time or a proper noun; one clause; nine
 * words at most. That rule is what keeps the copy from drifting back into
 * abstraction, and it survived every redesign because it was never about style.
 */
export function Display({
  as: Tag = "h1",
  scale = "page",
  className = "",
  children,
}: {
  as?: "h1" | "h2";
  scale?: "page" | "hero";
  className?: string;
  children: ReactNode;
}) {
  const ramp =
    scale === "hero"
      ? "t-hero text-[clamp(2.5rem,6.4vw,5.75rem)]"
      : "t-h2 text-[clamp(2rem,3.4vw,3.25rem)]";
  return <Tag className={`${ramp} text-ink ${className}`}>{children}</Tag>;
}

export function Heading({
  as: Tag = "h2",
  className = "",
  children,
}: {
  as?: "h2" | "h3";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={`t-h2 text-[clamp(1.875rem,3.4vw,3.25rem)] text-ink ${className}`}>
      {children}
    </Tag>
  );
}

export function Subhead({
  as: Tag = "h3",
  className = "",
  children,
}: {
  as?: "h3" | "h4";
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={`t-h3 text-[1.375rem] text-ink ${className}`}>{children}</Tag>;
}

/** A big condensed count. Scale without spending whitespace on it. */
export function Figure({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`t-figure text-[clamp(3rem,7vw,6rem)] text-ink ${className}`}>{children}</div>
  );
}

/** A mono field label: panel headers, eyebrows, lane names. */
export function Sheet({ className = "", children }: { className?: string; children: ReactNode }) {
  return <span className={`t-field text-muted ${className}`}>{children}</span>;
}

/** Data the software emitted, and only that. Never flavour on a sentence. */
export function Field({ className = "", children }: { className?: string; children: ReactNode }) {
  return <span className={`t-data text-[11px] leading-4 text-muted ${className}`}>{children}</span>;
}

export function Lede({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={`max-w-[58ch] text-[clamp(1.0625rem,1.35vw,1.25rem)] leading-[1.55] text-ink2 ${className}`}
    >
      {children}
    </p>
  );
}

export function Body({ className = "", children }: { className?: string; children: ReactNode }) {
  return <p className={`text-[15px] leading-[1.6] text-ink2 ${className}`}>{children}</p>;
}

/** The one italic voice: figure captions, margin notes, the colophon. */
export function Note({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <p className={`text-[1.0625rem] italic leading-[1.6] text-ink2 ${className}`}>{children}</p>
  );
}

/* -------------------------------------------------------------------------
   Controls
------------------------------------------------------------------------- */

/** The primary control. Ink, because a control is a human action. */
export function Button({
  href,
  external,
  variant = "primary",
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  variant?: "primary" | "secondary";
  className?: string;
  children: ReactNode;
}) {
  const skin =
    variant === "primary"
      ? // Ground on ink, 15.05:1. Not `text-ink`: the label sits ON the ink
        // fill, and the swap that black-on-blacked `StateTag` hit the primary
        // button too — which is every "human action" control on the site, the
        // one object the inversion exists to make findable.
        "bg-ink text-ground hover:bg-ink2"
      : "border border-rule text-ink hover:bg-ink hover:text-ground";
  const classes = `rounded-control inline-flex items-center gap-2 px-5 py-3 text-[15px] font-semibold transition-colors duration-100 ${skin} ${className}`;
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

/** A full-width strip. Kept for the install command and page-level actions. */
export function ActionStrip({
  href,
  external,
  mono = false,
  trailing,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  mono?: boolean;
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  // Resting state is ink on white; only the hover fill is ink, and only there
  // does the label go light. The swap left `text-ground` on both states, which
  // is #f2f0ec on #ffffff — 1.09:1, a strip with nothing legible in it until
  // you happen to hover.
  const classes = `rounded-control group flex min-h-[3.25rem] w-full items-center justify-between gap-4 border border-rule bg-surface px-4 text-ink transition-colors duration-100 hover:bg-ink hover:text-ground ${className}`;
  const inner = (
    <>
      <span className={`min-w-0 truncate ${mono ? "t-data text-[13px]" : "text-[15px]"}`}>
        {children}
      </span>
      {trailing && <span className="t-field shrink-0 opacity-70">{trailing}</span>}
    </>
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {inner}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

/** A text link with an underline that draws from the left on hover. */
export function TextLink({
  href,
  external,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `group inline-flex w-fit items-baseline text-[15px] font-semibold text-ink ${className}`;
  const inner = (
    <span className="relative">
      {children}
      <span
        aria-hidden
        className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-ink transition-transform duration-150 group-hover:scale-x-100"
      />
    </span>
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {inner}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

/* -------------------------------------------------------------------------
   Fragments
------------------------------------------------------------------------- */

export function Rule({
  weight = "hair",
  className = "",
}: {
  weight?: "hair" | "structural";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`block h-px w-full ${weight === "structural" ? "bg-rule" : "bg-hairline"} ${className}`}
    />
  );
}

/**
 * A row. A set of things is a stack of rows sharing one hairline, with an
 * optional 3px department spine on the left edge — never a grid of cards.
 */
export function Row({
  href,
  external,
  dept,
  className = "",
  children,
}: {
  href?: string;
  external?: boolean;
  dept?: Dept;
  className?: string;
  children: ReactNode;
}) {
  const base = `relative -mt-px flex items-start gap-x-6 gap-y-2 border-y border-hairline py-4 ${
    dept ? "pl-4" : "px-1"
  } ${className}`;
  const spine = dept ? (
    <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${DEPT_FULL[dept]}`} />
  ) : null;

  if (!href) {
    return (
      <div className={base}>
        {spine}
        {children}
      </div>
    );
  }
  const hover = "transition-colors duration-100 hover:bg-ink hover:text-ground";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`group ${base} ${hover}`}>
        {spine}
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={`group ${base} ${hover}`}>
      {spine}
      {children}
    </Link>
  );
}

/**
 * A state label.
 *
 * The human states — Decision and Approval — are ink, with no hue at all.
 * That is the palette's central rule and it is also an accessibility rule:
 * ink on ground is 16.43:1, and it means the two states that need a person are
 * the highest-contrast things on a page full of colour.
 */
export function StateTag({
  state,
  className = "",
  children,
}: {
  state: "run" | "decision" | "approval" | "standdown";
  className?: string;
  children: ReactNode;
}) {
  const human = state === "decision" || state === "approval";
  // `text-ground` and NOT `text-ink`: the label sits ON the ink fill, so it has
  // to be the light value. The mechanical token swap mapped the old
  // `text-paper-50` to `text-ink` and made every Decision and Approval on the
  // site black-on-black at 1.00:1 — the one rule the palette exists to state,
  // rendered invisible. Ground on ink is 15.05:1.
  const skin = human
    ? "bg-ink text-ground"
    : state === "standdown"
      ? "border border-rule text-muted"
      : "border border-hairline text-muted";
  return (
    <span
      className={`t-field rounded-chip inline-flex items-center gap-1.5 px-2 py-1 leading-none ${skin} ${className}`}
    >
      {children}
    </span>
  );
}
