import type { ReactNode } from "react";
import { Link } from "@/lib/router";

/**
 * Shared marketing primitives aligned with the product application.
 *
 * Neutral surfaces do the structural work. Indigo identifies actions and
 * focus, while department colours stay confined to small labels and markers.
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

/** Department hues are compatibility tokens for small semantic markers. */
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

/** Pale department grounds for compact labels and selected states. */
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
  finance: "text-emerald-800",
  repositories: "text-violet-800",
  marketing: "text-fuchsia-800",
  workspace: "text-indigo-800",
  email: "text-sky-800",
  revenue: "text-orange-800",
  operations: "text-amber-900",
  people: "text-rose-800",
};

/** Strong outlines for chart marks that must remain distinct on white. */
export const DEPT_BORDER: Record<Dept, string> = {
  finance: "border-emerald-600",
  repositories: "border-violet-600",
  marketing: "border-fuchsia-600",
  workspace: "border-indigo-600",
  email: "border-sky-600",
  revenue: "border-orange-600",
  operations: "border-amber-600",
  people: "border-rose-600",
};

/** A compact department label; hue never becomes the surrounding surface. */
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
      className={`t-field rounded-md inline-flex items-center border border-rule px-2 py-1 leading-none ${DEPT_TINT[dept]} ${DEPT_TEXT[dept]} ${className}`}
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
  ink: "bg-ink text-ground",
};

export type BandPad = "xs" | "s" | "m" | "l" | "none";

/**
 * A band declares its opening and closing rhythm independently so adjacent
 * sections retain predictable spacing.
 */
const BAND_OPEN: Record<BandPad, string> = {
  none: "",
  xs: "pt-6 sm:pt-8",
  s: "pt-8 sm:pt-10",
  m: "pt-12 sm:pt-14 lg:pt-16",
  l: "pt-14 sm:pt-16 lg:pt-20",
};

const BAND_CLOSE: Record<BandPad, string> = {
  none: "",
  xs: "pb-6 sm:pb-8",
  s: "pb-8 sm:pb-10",
  m: "pb-12 sm:pb-14 lg:pb-16",
  l: "pb-14 sm:pb-16 lg:pb-20",
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
        rule && tone !== "ink" ? "border-t border-rule" : ""
      } ${className}`}
    >
      <div className={`${BAND_OPEN[open ?? pad]} ${BAND_CLOSE[close ?? pad]}`}>{children}</div>
    </section>
  );
}

/** The shared page measure used by both the marketing and documentation UI. */
export function Container({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 ${className}`}>{children}</div>
  );
}

/**
 * A section heading with an optional supporting column.
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
      {eyebrow && <div className="t-field mb-3 text-muted">{eyebrow}</div>}
      <div className="grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <h2 className="t-h2 max-w-[26ch] text-[clamp(1.75rem,3vw,2.75rem)] text-ink">{title}</h2>
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
 * Compatibility wrapper used by established sections. It renders its sheet
 * and fields as compact metadata above the content rather than as a gutter.
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
        <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
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
      {margin && <div className="mt-10 border-t border-rule pt-6">{margin}</div>}
    </div>
  );
}

/**
 * A product-like card: white, lightly bordered, softly elevated, and rounded.
 * Department context is a short marker rather than a full-width colour field.
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
    <div
      className={`relative overflow-hidden rounded-xl border border-rule bg-surface shadow-sm ${className}`}
    >
      {dept && (
        <span
          aria-hidden
          className={`absolute left-4 top-0 h-1 w-8 rounded-b-full ${DEPT_FULL[dept]}`}
        />
      )}
      {(title || meta) && (
        <div className="flex items-baseline justify-between gap-3 border-b border-rule px-4 pb-3 pt-4">
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
      <div className="overflow-hidden rounded-xl border border-rule bg-surface shadow-sm">
        {children}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-3">
        <span className="t-field text-muted">{figure}</span>
        <span className="text-[14px] leading-6 text-ink2">{caption}</span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   Type
------------------------------------------------------------------------- */

/**
 * Display type uses the same Inter-led hierarchy as product page titles.
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
      ? "t-hero text-[clamp(2.5rem,6vw,4.75rem)]"
      : "t-h2 text-[clamp(2rem,3.4vw,3rem)]";
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
    <Tag className={`t-h2 text-[clamp(1.75rem,3vw,2.75rem)] text-ink ${className}`}>{children}</Tag>
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
  return <Tag className={`t-h3 text-[1.25rem] text-ink ${className}`}>{children}</Tag>;
}

/** A prominent product metric. */
export function Figure({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`t-figure text-[clamp(2.75rem,6vw,5rem)] text-ink ${className}`}>
      {children}
    </div>
  );
}

/** A compact metadata label. */
export function Sheet({ className = "", children }: { className?: string; children: ReactNode }) {
  return <span className={`t-field text-muted ${className}`}>{children}</span>;
}

/** Compact software-emitted data. */
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

/** Supporting note copy. */
export function Note({ className = "", children }: { className?: string; children: ReactNode }) {
  return <p className={`text-[1rem] leading-[1.6] text-ink2 ${className}`}>{children}</p>;
}

/* -------------------------------------------------------------------------
   Controls
------------------------------------------------------------------------- */

/** Product-style primary and secondary actions. */
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
      ? "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700"
      : "border border-rule bg-surface text-ink shadow-sm hover:bg-slate-50";
  const classes = `inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 ${skin} ${className}`;
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
  const classes = `group flex min-h-[3.25rem] w-full items-center justify-between gap-4 rounded-xl border border-rule bg-surface px-4 text-ink shadow-sm transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50 ${className}`;
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

/** A compact inline action link. */
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
  const classes = `group inline-flex w-fit items-baseline text-[15px] font-medium text-indigo-600 hover:text-indigo-700 ${className}`;
  const inner = (
    <span className="relative">
      {children}
      <span
        aria-hidden
        className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-0 bg-indigo-600 transition-transform duration-150 group-hover:scale-x-100"
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
 * A compact card row. Department context stays in a small leading marker.
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
  const base = `relative flex items-start gap-x-6 gap-y-2 rounded-lg border border-rule bg-surface py-4 shadow-sm ${
    href ? "group transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50" : ""
  } ${dept ? "pl-9 pr-4" : "px-4"} ${className}`;
  const spine = dept ? (
    <span
      aria-hidden
      className={`absolute left-4 top-[1.375rem] h-2 w-2 rounded-full ${DEPT_FULL[dept]}`}
    />
  ) : null;

  if (!href) {
    return (
      <div className={base}>
        {spine}
        {children}
      </div>
    );
  }
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={base}>
        {spine}
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={base}>
      {spine}
      {children}
    </Link>
  );
}

/** A small semantic state label. */
export function StateTag({
  state,
  className = "",
  children,
}: {
  state: "run" | "decision" | "approval" | "standdown";
  className?: string;
  children: ReactNode;
}) {
  const skin = {
    run: "border border-sky-200 bg-sky-50 text-sky-700",
    decision: "border border-violet-200 bg-violet-50 text-violet-700",
    approval: "border border-amber-200 bg-amber-50 text-amber-700",
    standdown: "border border-rose-200 bg-rose-50 text-rose-700",
  }[state];
  return (
    <span
      className={`t-field inline-flex items-center gap-1.5 rounded-md px-2 py-1 leading-none ${skin} ${className}`}
    >
      {children}
    </span>
  );
}
