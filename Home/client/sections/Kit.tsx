import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Check, Copy } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Link } from "@/lib/router";

/**
 * The marketing kit, in black and white.
 *
 * Paper and ink do the structural work. There is no accent hue: emphasis is
 * the italic turn in a headline, and inversion — the one thing on a surface
 * that needs a person is drawn solid. Department hues only ever appear as
 * small dots beside a label, never as a surface.
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

export const DEPT_DOT: Record<Dept, string> = {
  finance: "bg-dept-finance",
  repositories: "bg-dept-repositories",
  marketing: "bg-dept-marketing",
  workspace: "bg-dept-workspace",
  email: "bg-dept-email",
  revenue: "bg-dept-revenue",
  operations: "bg-dept-operations",
  people: "bg-dept-people",
};

export const DEPT_LABEL: Record<Dept, string> = {
  finance: "Finance",
  repositories: "Repositories",
  marketing: "Marketing",
  workspace: "Workspace",
  email: "Email",
  revenue: "Revenue",
  operations: "Operations",
  people: "People",
};

export function DeptDot({ dept, className = "" }: { dept: Dept; className?: string }) {
  return (
    <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DEPT_DOT[dept]} ${className}`} />
  );
}

/** A department label: a dot and the name, in the quiet mono voice. */
export function DeptLabel({
  dept,
  night = false,
  className = "",
}: {
  dept: Dept;
  night?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] ${
        night ? "text-night-muted" : "text-ink-500"
      } ${className}`}
    >
      <DeptDot dept={dept} />
      {DEPT_LABEL[dept]}
    </span>
  );
}

/** Kept for the product mock-ups: a compact department chip. */
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
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-paper-raised px-2.5 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.08em] text-ink-600 ${className}`}
    >
      <DeptDot dept={dept} className="!h-1.5 !w-1.5" />
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------
   Layout
------------------------------------------------------------------------- */

export function Container({
  className = "",
  narrow = false,
  children,
}: {
  className?: string;
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`mx-auto w-full ${narrow ? "max-w-[52rem]" : "max-w-site"} px-5 sm:px-8 lg:px-10 ${className}`}
    >
      {children}
    </div>
  );
}

type Space = "none" | "sm" | "md" | "lg";

const SPACE: Record<Space, string> = {
  none: "",
  sm: "py-14 sm:py-16 lg:py-20",
  md: "py-20 sm:py-24 lg:py-32",
  lg: "py-24 sm:py-28 lg:py-40",
};

const TONE = {
  paper: "bg-paper text-ink",
  raised: "bg-paper-raised text-ink",
  sunken: "bg-paper-sunken text-ink",
} as const;

export function Section({
  id,
  tone = "paper",
  space = "md",
  rule = false,
  className = "",
  children,
}: {
  id?: string;
  tone?: keyof typeof TONE;
  space?: Space;
  /** A hairline across the top, for two paper bands that meet. */
  rule?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative ${TONE[tone]} ${SPACE[space]} ${rule ? "border-t border-line" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * The night panel: an inset, rounded block of black. Used for the hero, the
 * whole-shift chart and the closing call to action — the three places the
 * page is talking about the night itself.
 */
export function NightPanel({
  id,
  dawn,
  className = "",
  children,
}: {
  id?: string;
  /** 0–1: how much morning light has reached the horizon. */
  dawn?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="px-2 sm:px-3 lg:px-4">
      <div
        className={`night-sky grain on-night relative overflow-hidden rounded-[1.75rem] text-white sm:rounded-[2.25rem] ${className}`}
        style={dawn === undefined ? undefined : ({ "--dawn": dawn } as React.CSSProperties)}
      >
        {children}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------
   Type
------------------------------------------------------------------------- */

/** The small mono label above a heading, led by a short rule. */
export function Kicker({
  night = false,
  className = "",
  children,
}: {
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={`kicker inline-flex items-center gap-3 ${night ? "text-night-muted" : "text-ink-500"} ${className}`}>
      <span aria-hidden className={`h-px w-6 ${night ? "bg-white/50" : "bg-ink"}`} />
      {children}
    </p>
  );
}

const TITLE_SIZE = {
  "2xl": "text-display-2xl",
  xl: "text-display-xl",
  lg: "text-display-lg",
  md: "text-display-md",
  sm: "text-display-sm",
} as const;

export function Title({
  as: Tag = "h2",
  size = "lg",
  className = "",
  children,
}: {
  as?: "h1" | "h2" | "h3" | "p";
  size?: keyof typeof TITLE_SIZE;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={`font-display text-balance ${TITLE_SIZE[size]} ${className}`}>{children}</Tag>
  );
}

/** The italic turn inside a headline, a step lighter than the rest of it. */
export function Em({
  tone = "muted",
  className = "",
  children,
}: {
  tone?: "inherit" | "muted" | "night";
  className?: string;
  children: ReactNode;
}) {
  const color = {
    inherit: "",
    muted: "text-ink-400",
    night: "text-white/55",
  }[tone];
  return <em className={`font-display italic ${color} ${className}`}>{children}</em>;
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
      className={`max-w-[58ch] text-pretty text-[1.0625rem] leading-[1.6] sm:text-[1.1875rem] ${
        night ? "text-night-muted" : "text-ink-600"
      } ${className}`}
    >
      {children}
    </p>
  );
}

/**
 * A section opening: kicker, headline, and an optional lede. Split (lede
 * beside the headline on wide screens), left, or centred.
 */
export function SectionHead({
  kicker,
  title,
  lede,
  aside,
  align = "split",
  night = false,
  size = "lg",
  as = "h2",
  className = "",
}: {
  kicker?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  align?: "split" | "left" | "center";
  night?: boolean;
  size?: keyof typeof TITLE_SIZE;
  as?: "h1" | "h2";
  className?: string;
}) {
  const ref = useReveal<HTMLDivElement>(0, 70);
  if (align === "center") {
    return (
      <div ref={ref} className={`mx-auto flex max-w-[48rem] flex-col items-center text-center ${className}`}>
        {kicker && <Kicker night={night}>{kicker}</Kicker>}
        <Title as={as} size={size} className={kicker ? "mt-6" : ""}>
          {title}
        </Title>
        {lede && (
          <Lede night={night} className="mx-auto mt-6">
            {lede}
          </Lede>
        )}
        {aside && <div className="mt-8">{aside}</div>}
      </div>
    );
  }
  if (align === "left") {
    return (
      <div ref={ref} className={`max-w-[50rem] ${className}`}>
        {kicker && <Kicker night={night}>{kicker}</Kicker>}
        <Title as={as} size={size} className={kicker ? "mt-6" : ""}>
          {title}
        </Title>
        {lede && (
          <Lede night={night} className="mt-6">
            {lede}
          </Lede>
        )}
        {aside && <div className="mt-8">{aside}</div>}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={`grid gap-x-16 gap-y-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end ${className}`}
    >
      <div className="min-w-0">
        {kicker && <Kicker night={night}>{kicker}</Kicker>}
        <Title as={as} size={size} className={kicker ? "mt-6" : ""}>
          {title}
        </Title>
      </div>
      {(lede || aside) && (
        <div className="min-w-0 lg:pb-2">
          {lede && <Lede night={night}>{lede}</Lede>}
          {aside && <div className={lede ? "mt-6" : ""}>{aside}</div>}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Actions
------------------------------------------------------------------------- */

type ButtonVariant = "ink" | "paper" | "outline" | "outline-night" | "ghost";

const BUTTON_SKIN: Record<ButtonVariant, string> = {
  ink: "bg-ink text-white hover:bg-ink-800 shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.2),0_6px_16px_-8px_rgb(0_0_0/0.45)]",
  paper:
    "bg-white text-ink hover:bg-ink-50 shadow-[inset_0_-1px_0_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.3),0_10px_30px_-12px_rgb(255_255_255/0.35)]",
  outline: "border border-line-strong bg-white/60 text-ink hover:border-ink-300 hover:bg-white",
  "outline-night": "border border-white/15 bg-white/[0.03] text-white hover:border-white/30 hover:bg-white/[0.07]",
  ghost: "text-ink hover:bg-ink/5",
};

const BUTTON_SIZE = {
  sm: "h-9 px-4 text-[13px] gap-1.5",
  md: "h-11 px-5 text-[15px] gap-2",
  lg: "h-12 px-6 text-[15px] gap-2 sm:h-[3.25rem] sm:px-7 sm:text-base",
} as const;

export function Button({
  href,
  external = false,
  variant = "ink",
  size = "md",
  arrow = false,
  className = "",
  children,
}: {
  href: string;
  external?: boolean;
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZE;
  /** Show a trailing arrow that nudges on hover. */
  arrow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `press group inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-medium tracking-[-0.005em] ${BUTTON_SIZE[size]} ${BUTTON_SKIN[variant]} ${className}`;
  const inner = (
    <>
      {children}
      {arrow &&
        (external ? (
          <ArrowUpRight aria-hidden className="nudge-up h-4 w-4" />
        ) : (
          <ArrowRight aria-hidden className="nudge h-4 w-4" />
        ))}
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
  // Absolute URLs (Genosyn Cloud, mailto:) render as plain anchors; Link only
  // intercepts the routes this app owns.
  return (
    <Link href={href} className={classes}>
      {inner}
    </Link>
  );
}

export function TextLink({
  href,
  external = false,
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
  const classes = `group inline-flex w-fit items-center gap-1.5 text-[15px] font-medium underline decoration-1 underline-offset-[6px] transition-colors duration-200 ${
    night
      ? "text-white decoration-white/25 hover:decoration-white"
      : "text-ink decoration-ink/20 hover:decoration-ink"
  } ${className}`;
  const icon = external ? (
    <ArrowUpRight aria-hidden className="nudge-up h-4 w-4 opacity-70" />
  ) : (
    <ArrowRight aria-hidden className="nudge h-4 w-4 opacity-70" />
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {children}
        {icon}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {children}
      {icon}
    </Link>
  );
}

/**
 * The install one-liner with a copy button. Copy failures fall back to a
 * visible hint — the command itself stays selectable.
 */
export function CopyCommand({
  command,
  night = false,
  className = "",
}: {
  command: string;
  night?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setFailed(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className={className}>
      <div
        className={`flex h-12 min-w-0 items-center gap-3 rounded-2xl pl-4 pr-1.5 ${
          night
            ? "border border-white/10 bg-white/[0.04] text-white"
            : "border border-line bg-paper-raised text-ink shadow-soft"
        }`}
      >
        <span aria-hidden className={`select-none font-mono text-[13px] ${night ? "text-white/40" : "text-ink-400"}`}>
          $
        </span>
        <code className="scrollbar-none min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] sm:text-[13px]">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[12px] font-medium transition-colors ${
            night ? "text-night-muted hover:bg-white/10 hover:text-white" : "text-ink-500 hover:bg-paper-sunken hover:text-ink"
          }`}
        >
          {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          <span className="sr-only"> install command</span>
        </button>
      </div>
      {failed && (
        <p role="status" className={`mt-2 text-xs ${night ? "text-night-muted" : "text-ink-500"}`}>
          Select the command to copy it by hand.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Surfaces and tags
------------------------------------------------------------------------- */

/** A whole card that links somewhere. */
export function LinkCard({
  href,
  className = "",
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`lift group block rounded-3xl border border-line bg-paper-raised hover:border-line-strong hover:shadow-lifted ${className}`}
    >
      {children}
    </Link>
  );
}

export type StopState = "run" | "decision" | "approval" | "standdown";

/**
 * A Decision and an Approval are different stops (AGENTS.md §3), so they are
 * never drawn alike: a Decision — the employee asking — is solid; an Approval
 * — the system holding an action it already attempted — is outlined.
 */
export function StateTag({
  state,
  night = false,
  className = "",
  children,
}: {
  state: StopState;
  night?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const skin = night
    ? {
        run: "border-white/10 bg-white/[0.05] text-night-muted",
        decision: "border-white bg-white text-ink",
        approval: "border-white/60 bg-transparent text-white",
        standdown: "border-white/40 bg-transparent text-white",
      }[state]
    : {
        run: "border-line bg-paper-raised text-ink-600",
        decision: "border-ink bg-ink text-white",
        approval: "border-ink/70 bg-paper-raised text-ink",
        standdown: "border-ink/60 bg-paper-raised text-ink",
      }[state];
  const dot = night
    ? {
        run: "bg-moss-400",
        decision: "bg-ink",
        approval: "border border-white bg-transparent",
        standdown: "hatch-night !h-2 !w-2 rounded-[2px] border border-white/70",
      }[state]
    : {
        run: "bg-moss-500",
        decision: "bg-white",
        approval: "border border-ink bg-transparent",
        standdown: "hatch !h-2 !w-2 rounded-[2px] border border-ink",
      }[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] ${skin} ${className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

const AVATAR_SIZE = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-[11px]",
  lg: "h-12 w-12 text-[13px]",
} as const;

/**
 * An AI Employee's avatar: initials on a disc, with a small department dot.
 */
export function Avatar({
  initials,
  dept,
  size = "md",
  night = false,
  className = "",
}: {
  initials: string;
  dept?: Dept;
  size?: keyof typeof AVATAR_SIZE;
  night?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-mono font-medium tracking-tight ${AVATAR_SIZE[size]} ${
        night ? "bg-night-high text-white ring-1 ring-white/10" : "bg-paper-sunken text-ink-700 ring-1 ring-line"
      } ${className}`}
    >
      {initials}
      {dept && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ${
            night ? "ring-night-raised" : "ring-paper-raised"
          } ${DEPT_DOT[dept]}`}
        />
      )}
    </span>
  );
}

/** Two-to-four facts in a row, separated by hairlines. */
export function FactRow({
  items,
  night = false,
  className = "",
}: {
  items: ReactNode[];
  night?: boolean;
  className?: string;
}) {
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] ${
        night ? "text-night-muted" : "text-ink-500"
      } ${className}`}
    >
      {items.map((item, index) => (
        <li key={index} className="inline-flex items-center gap-5">
          {index > 0 && <span aria-hidden className={`h-3 w-px ${night ? "bg-white/15" : "bg-line-strong"}`} />}
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * Hours as a 24-hour clock string. Shared by the hero, the shift chart and
 * the role days so every surface formats time the same way.
 */
export function clock(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  const h = minutes === 60 ? whole + 1 : whole;
  const m = minutes === 60 ? 0 : minutes;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Blank cells that close the last row of a hairline grid (one drawn with
 * `gap-px` over a `bg-line` ground), so an odd count never leaves a grey hole.
 * Assumes one column below `sm`, two at `sm`, and three at `lg`.
 */
export function GridFill({ count, className = "bg-paper-raised" }: { count: number; className?: string }) {
  const sm = (2 - (count % 2)) % 2;
  const lg = (3 - (count % 3)) % 3;
  const cells = Array.from({ length: Math.max(sm, lg) }, (_, index) => {
    const atSm = index < sm;
    const atLg = index < lg;
    if (atSm && atLg) return "hidden sm:block";
    if (atSm) return "hidden sm:block lg:hidden";
    return "hidden lg:block";
  });
  return (
    <>
      {cells.map((visibility, index) => (
        <li key={index} aria-hidden className={`${visibility} ${className}`} />
      ))}
    </>
  );
}
