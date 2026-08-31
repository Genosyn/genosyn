import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Link } from "@/lib/router";
import { Display, Lede as KitLede } from "@/sections/Kit";

/**
 * The page-hero kit: the top band of every marketing page that is not the
 * landing page (products index, product detail, pricing, enterprise).
 *
 * The landing hero is its own composition — it is centred and full-bleed — so
 * it does not use this. Everything here is the two-column variant: copy on the
 * left, a live product panel on the right from `xl` up.
 *
 * Tone used to be a prop with light and dark variants that each carried their
 * own badge, button and proof-row skins. There is one skin now; the hairline
 * grid and the faint wash behind the band are what keep it from reading as a
 * blank white rectangle.
 */

/**
 * Section shell: canvas, light wash, hairline grid, and container rhythm.
 *
 * `tight` halves the bottom padding. A hero with a product panel needs the
 * room underneath; a centred, copy-only hero (pricing) followed by a section
 * that opens with its own 8rem of padding just leaves a hole.
 */
export function HeroSection({
  tight = false,
  children,
}: {
  tight?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="grain relative isolate overflow-hidden bg-paper-50">
      <div aria-hidden className="pointer-events-none absolute inset-0 aurora animate-drift" />
      <div aria-hidden className="pointer-events-none absolute inset-0 paper-grid" />
      <div
        className={`relative z-10 mx-auto max-w-[88rem] px-5 pt-14 sm:px-8 sm:pt-20 lg:pt-24 ${
          tight ? "pb-10 sm:pb-12" : "pb-20 sm:pb-24 lg:pb-28"
        }`}
      >
        {children}
      </div>
    </section>
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
    <div className="grid gap-14 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:items-center xl:gap-16">
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
 * label. `leading` replaces the default live dot (the product hero puts its
 * product icon there).
 */
export function HeroBadge({
  href,
  external,
  leading,
  className = "",
  children,
}: {
  href?: string;
  external?: boolean;
  leading?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const classes = `inline-flex items-center gap-2.5 rounded-full border border-zinc-200 bg-white/85 py-1.5 pl-3 pr-3.5 text-xs font-semibold text-zinc-600 shadow-card backdrop-blur ${
    href ? "transition hover:border-zinc-400 hover:text-zinc-900" : ""
  } ${className}`;

  const body = (
    <>
      {leading ?? (
        <span aria-hidden className="preview-live h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
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
  return <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-zinc-300" />;
}

/**
 * Page headline. One step down from the landing page's Display so a product
 * name never outshouts the site's own claim.
 */
export function HeroTitle({ children }: { children: ReactNode }) {
  return (
    <Display className="mt-7 text-[clamp(2.25rem,5vw,3.75rem)] leading-[1.02] xl:text-[3.25rem]">
      {children}
    </Display>
  );
}

/**
 * The quiet half of a two-tone headline. The loud half is the default black.
 * zinc-500, not lighter — see the note on `Muted` in Kit.tsx.
 */
export function HeroTitleMuted({ children }: { children: ReactNode }) {
  return <span className="text-zinc-500">{children}</span>;
}

/** Large secondary line under the headline (product heroes use this). */
export function HeroTagline({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 max-w-xl text-balance text-lg font-medium leading-8 tracking-[-0.015em] text-zinc-500 sm:text-xl">
      {children}
    </p>
  );
}

/** Supporting paragraph. */
export function HeroLede({ children }: { children: ReactNode }) {
  return <KitLede className="mt-5 max-w-xl">{children}</KitLede>;
}

export function HeroActions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {children}
    </div>
  );
}

type HeroButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON_SKIN: Record<HeroButtonVariant, string> = {
  primary: "bg-ink-600 text-white shadow-card hover:bg-ink-900",
  secondary:
    "border border-zinc-300 bg-white text-zinc-900 shadow-card hover:border-zinc-400 hover:bg-paper-100",
  ghost: "text-zinc-500 hover:text-zinc-900",
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
  const shape =
    variant === "ghost" ? "px-3 py-3" : "px-5 py-3.5 w-full sm:w-auto hover:-translate-y-0.5";
  const classes = `inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition duration-200 ${shape} ${BUTTON_SKIN[variant]}`;

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
  return (
    <ul className="mt-10 grid max-w-lg gap-x-6 gap-y-3 text-xs font-medium text-zinc-600 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item} className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-900"
          >
            <Check className="h-3 w-3" />
          </span>
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
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[3rem] bg-[radial-gradient(60%_55%_at_50%_40%,rgba(9,9,11,0.10),transparent_72%)] blur-2xl"
      />
      <div className="mb-3 flex items-center justify-between gap-4 px-1 text-[11px] font-semibold text-zinc-500">
        <span className="truncate">{label}</span>
        {status && (
          <span className="inline-flex shrink-0 items-center gap-2 text-emerald-700">
            <span aria-hidden className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {status}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
