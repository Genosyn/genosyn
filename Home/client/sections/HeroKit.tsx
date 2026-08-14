import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "@/lib/router";

/**
 * Shared building blocks for every marketing hero (landing, products index,
 * product detail, enterprise).
 *
 * Before this existed each hero carried its own copy of the badge, button,
 * proof-row and panel-caption class strings, which had drifted apart — four
 * different heading ramps, three different check icons, two different
 * secondary-button shadows. The type ramp in particular was sized for a
 * full-width column but rendered inside the narrow left column of the hero
 * grid, so headlines broke at 8-10 characters per line on desktop.
 *
 * `HeroTitle` below is tuned so every headline the site ships lands in two or
 * three lines at every breakpoint. The step *down* at `xl` is deliberate: that
 * is where the layout splits into two columns and the copy column roughly
 * halves in width.
 */

export type HeroTone = "light" | "dark";

const HeroToneContext = createContext<HeroTone>("light");

function useHeroTone(): HeroTone {
  return useContext(HeroToneContext);
}

const SHELL: Record<HeroTone, string> = {
  light: "border-slate-200 bg-white text-slate-950",
  dark: "border-slate-800 bg-slate-950 text-white",
};

const BACKDROP: Record<HeroTone, string> = {
  light: "marketing-grid opacity-60",
  dark: "marketing-grid-dark opacity-60",
};

const GLOW: Record<HeroTone, string> = {
  light: "bg-slate-200/70",
  dark: "bg-slate-700/30",
};

/** Section shell: background, decorative backdrop, and container rhythm. */
export function HeroSection({
  tone = "light",
  children,
}: {
  tone?: HeroTone;
  children: ReactNode;
}) {
  return (
    <HeroToneContext.Provider value={tone}>
      <section className={`relative overflow-hidden border-b ${SHELL[tone]}`}>
        <div aria-hidden className={`pointer-events-none absolute inset-0 ${BACKDROP[tone]}`} />
        <div
          aria-hidden
          className={`pointer-events-none absolute -top-48 left-1/2 h-[42rem] w-[68rem] -translate-x-1/2 rounded-full blur-3xl ${GLOW[tone]}`}
        />
        {/* max-w-7xl, not a wider hero-only container: the Nav and every
            section below the fold use max-w-7xl, and a wider hero left the h1
            starting up to 80px to the left of the logo above it. */}
        <div className="relative mx-auto max-w-7xl px-5 pb-16 pt-12 sm:px-6 sm:pb-20 sm:pt-16 lg:pb-24 lg:pt-20">
          {children}
        </div>
      </section>
    </HeroToneContext.Provider>
  );
}

/**
 * Copy on the left, product panel on the right — but only from `xl` up.
 *
 * The split used to happen at `lg`, which left both columns starved between
 * 1024px and 1279px: the headline had ~440px to work with and the product
 * preview (which draws its own sidebar at `lg`) had ~550px. Stacking through
 * `lg` gives the preview the full container there and keeps the headline on a
 * comfortable measure.
 */
export function HeroGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-12 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:items-center xl:gap-14">
      {children}
    </div>
  );
}

/** The left column. Left-aligned at every width, on every hero. */
export function HeroCopy({ children }: { children: ReactNode }) {
  return <div className="max-w-2xl xl:max-w-none">{children}</div>;
}

/**
 * Eyebrow pill. Renders as a link when `href` is set, otherwise as a plain
 * label. `leading` replaces the default status dot (the product hero puts its
 * product icon there).
 */
export function HeroBadge({
  href,
  external,
  leading,
  className,
  children,
}: {
  href?: string;
  external?: boolean;
  leading?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const tone = useHeroTone();
  const skin =
    tone === "dark"
      ? "border-white/15 bg-white/[0.06] text-slate-200"
      : "border-slate-300 bg-white/90 text-slate-700 backdrop-blur";
  const interactive = href
    ? tone === "dark"
      ? "transition hover:border-white/30 hover:text-white"
      : "transition hover:border-slate-400 hover:text-slate-950"
    : "";
  const classes = `inline-flex items-center gap-2 rounded-full border py-1.5 pl-3 pr-3.5 text-xs font-semibold shadow-[0_1px_2px_rgba(15,23,42,0.06)] ${skin} ${interactive} ${className ?? ""}`;

  const body = (
    <>
      {leading ?? (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
      )}
      {children}
    </>
  );

  if (href && external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {body}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }

  if (href) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }

  return <span className={classes}>{body}</span>;
}

/** Decorative separator inside a badge. */
export function HeroBadgeDot() {
  const tone = useHeroTone();
  return (
    <span
      aria-hidden
      className={`h-1 w-1 shrink-0 rounded-full ${tone === "dark" ? "bg-white/30" : "bg-slate-300"}`}
    />
  );
}

/**
 * The one headline ramp for the whole marketing site. Sized against the column
 * it actually renders in so headlines land in two or three lines everywhere.
 */
export function HeroTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="mt-6 text-balance text-[clamp(2.25rem,7.5vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] md:text-[3.5rem] md:leading-[1.02] xl:text-[3rem] xl:leading-[1]">
      {children}
    </h1>
  );
}

/** The muted half of a two-tone headline. */
export function HeroTitleMuted({ children }: { children: ReactNode }) {
  const tone = useHeroTone();
  return <span className={tone === "dark" ? "text-slate-400" : "text-slate-500"}>{children}</span>;
}

/** Large secondary line under the headline (product heroes use this). */
export function HeroTagline({ children }: { children: ReactNode }) {
  const tone = useHeroTone();
  return (
    <p
      className={`mt-4 max-w-xl text-balance text-lg font-medium leading-7 tracking-[-0.015em] sm:text-xl sm:leading-8 ${
        tone === "dark" ? "text-slate-400" : "text-slate-600"
      }`}
    >
      {children}
    </p>
  );
}

/** Supporting paragraph. */
export function HeroLede({ children }: { children: ReactNode }) {
  const tone = useHeroTone();
  return (
    <p
      className={`mt-5 max-w-xl text-pretty text-base leading-7 sm:text-lg sm:leading-8 ${
        tone === "dark" ? "text-slate-300" : "text-slate-600"
      }`}
    >
      {children}
    </p>
  );
}

export function HeroActions({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">{children}</div>;
}

type HeroButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON_SKIN: Record<HeroTone, Record<HeroButtonVariant, string>> = {
  light: {
    primary:
      "bg-slate-950 text-white shadow-[0_8px_20px_-10px_rgba(15,23,42,0.8)] hover:bg-slate-800 hover:shadow-md",
    secondary:
      "border border-slate-300 bg-white text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.05)] hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm",
    ghost: "text-slate-600 hover:text-slate-950",
  },
  dark: {
    primary: "bg-white text-slate-950 shadow-sm hover:bg-slate-100 hover:shadow-md",
    secondary:
      "border border-white/20 bg-white/[0.06] text-white hover:border-white/30 hover:bg-white/10",
    ghost: "text-slate-400 hover:text-white",
  },
};

export function HeroButton({
  href,
  external,
  variant = "primary",
  children,
}: {
  href: string;
  external?: boolean;
  variant?: HeroButtonVariant;
  children: ReactNode;
}) {
  const tone = useHeroTone();
  const width = variant === "ghost" ? "" : "w-full sm:w-auto";
  const padding = variant === "ghost" ? "px-3 py-3" : "px-5 py-3";
  const motion = variant === "ghost" ? "" : "hover:-translate-y-0.5";
  const classes = `inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition ${padding} ${width} ${motion} ${BUTTON_SKIN[tone][variant]}`;

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

/** The short list of claims under the call to action. */
export function HeroProof({ items }: { items: string[] }) {
  const tone = useHeroTone();
  return (
    <ul
      className={`mt-8 grid max-w-lg gap-x-6 gap-y-2.5 text-xs font-medium sm:grid-cols-2 ${
        tone === "dark" ? "text-slate-400" : "text-slate-600"
      }`}
    >
      {items.map((item) => (
        <li key={item} className="flex items-center gap-2">
          <Check
            aria-hidden
            className={`h-3.5 w-3.5 shrink-0 ${tone === "dark" ? "text-white" : "text-slate-950"}`}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** The right column: a captioned frame around a live product preview. */
export function HeroPanel({
  label,
  status,
  children,
}: {
  label: string;
  status?: string;
  children: ReactNode;
}) {
  const tone = useHeroTone();
  return (
    <div className="relative">
      <div
        className={`mb-3 flex items-center justify-between gap-4 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
          tone === "dark" ? "text-slate-400" : "text-slate-600"
        }`}
      >
        <span className="truncate">{label}</span>
        {status && (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 ${
              tone === "dark" ? "text-emerald-400" : "text-emerald-700"
            }`}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {status}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
