import type { ReactNode } from "react";
import { findPageMeta } from "@/docs/nav";
import { Link } from "@/lib/router";

/**
 * The docs reading surface: the site's type and palette, without its
 * furniture. Headings are set in the display serif, prose in Geist at a size
 * meant for reading for minutes rather than scanning, and anything the
 * software emitted or ingested is set in mono.
 */

/**
 * Is this string something the software emitted or ingested? One token that
 * carries a dot or an underscore — `GENOSYN_PORT`, `security.encryptionSecret`
 * — rather than an ordinary noun like "Approval".
 */
function isEmitted(term: string): boolean {
  return /^\S+$/.test(term) && /[._]/.test(term);
}

type WithId = { children: ReactNode; id?: string };

/** The page header. `eyebrow` is accepted for compatibility and not rendered. */
export function PageHeader({ title, lead }: { eyebrow?: string; title: string; lead?: ReactNode }) {
  return (
    <header className="border-b border-line pb-10">
      <h1 className="text-balance font-display text-[clamp(2.4rem,5vw,3.5rem)] leading-[1.02] tracking-[-0.03em] text-ink">
        {title}
      </h1>
      {lead && <p className="mt-6 max-w-[60ch] text-[1.125rem] leading-[1.7] text-ink-600">{lead}</p>}
    </header>
  );
}

export function H2({ children, id }: WithId) {
  return (
    <h2
      id={id}
      className="mt-16 scroll-mt-28 text-balance font-display text-[1.95rem] leading-[1.12] tracking-[-0.02em] text-ink"
    >
      {children}
    </h2>
  );
}

export function H3({ children, id }: WithId) {
  return (
    <h3 id={id} className="mt-10 scroll-mt-28 text-[1.1rem] font-semibold tracking-[-0.01em] text-ink">
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-5 text-[1rem] leading-[1.8] text-ink-700">{children}</p>;
}

export function Strong({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-ink">{children}</span>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-5 ml-5 list-disc space-y-2.5 text-[1rem] leading-[1.75] text-ink-700 marker:text-ink-300">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="mt-5 ml-5 list-decimal space-y-2.5 text-[1rem] leading-[1.75] text-ink-700 marker:font-mono marker:text-[0.85em] marker:text-ink-400">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1.5">{children}</li>;
}

/** Inline literals. `break-words` matters: the longest inline string is 85 characters. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="break-words rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[0.84em] text-ink">
      {children}
    </code>
  );
}

/**
 * A code block. It scrolls on its own axis on narrow screens, so it takes
 * `tabIndex={0}` and its own focus ring — otherwise a keyboard-only reader
 * could not reach the end of a long command.
 */
export function Pre({ children, lang }: { children: ReactNode; lang?: string }) {
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-black bg-night">
      {lang && (
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <span className="flex gap-1.5" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-white/15" />
            <span className="h-2 w-2 rounded-full bg-white/15" />
            <span className="h-2 w-2 rounded-full bg-white/15" />
          </span>
          <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.1em] text-white/45">{lang}</span>
        </div>
      )}
      <pre
        tabIndex={0}
        className="overflow-x-auto px-4 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white sm:px-5"
      >
        <code className="block font-mono text-[12px] leading-[1.75] text-white/90 sm:text-[13px]">{children}</code>
      </pre>
    </div>
  );
}

const CALLOUT_WORD: Record<"info" | "warn" | "tip", string> = {
  info: "Note",
  warn: "Caution",
  tip: "Tip",
};

/**
 * A callout, told apart by weight rather than hue: a Caution — the one kind
 * that means a person has to be careful — is drawn in solid ink; a Note is
 * outlined; a Tip sits on a quiet fill.
 */
export function Callout({
  children,
  kind = "info",
  title,
}: {
  children: ReactNode;
  kind?: "info" | "warn" | "tip";
  title?: string;
}) {
  const skin = {
    info: "border-line bg-paper-raised",
    warn: "border-ink bg-paper-raised shadow-[inset_4px_0_0_0_#0E0E0D]",
    tip: "border-transparent bg-paper-sunken",
  }[kind];
  const badge = {
    info: "border-line-strong text-ink-600",
    warn: "border-ink bg-ink text-white",
    tip: "border-ink/20 text-ink-600",
  }[kind];
  return (
    <aside className={`mt-7 rounded-2xl border p-5 sm:p-6 ${skin}`}>
      <span
        className={`inline-flex rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase leading-none tracking-[0.1em] ${badge}`}
      >
        {CALLOUT_WORD[kind]}
      </span>
      {title && <p className="mt-3.5 text-[1.02rem] font-semibold leading-[1.45] text-ink">{title}</p>}
      <div className="mt-2 text-[0.95rem] leading-[1.7] text-ink-600">{children}</div>
    </aside>
  );
}

/** A term list, one hairline between each pair. */
export function KeyList({ rows }: { rows: Array<{ term: string; def: ReactNode }> }) {
  return (
    <dl className="mt-7 overflow-hidden rounded-2xl border border-line bg-paper-raised">
      {rows.map((r) => (
        <div
          key={r.term}
          className="grid grid-cols-1 gap-1.5 border-b border-line px-5 py-4 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-6 sm:px-6"
        >
          <dt
            className={
              isEmitted(r.term)
                ? "break-words font-mono text-[12.5px] leading-[1.6] text-ink"
                : "break-words text-[0.98rem] font-semibold leading-[1.5] text-ink"
            }
          >
            {r.term}
          </dt>
          <dd className="text-[0.98rem] leading-[1.7] text-ink-600">{r.def}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Inline links are carried by an underline, not by weight or hue. */
const INLINE_LINK =
  "font-medium text-ink underline decoration-ink/25 decoration-1 underline-offset-[4px] transition-colors hover:decoration-ink";

export function DocLink({ to, children }: { to: string; children?: ReactNode }) {
  const meta = findPageMeta(to);
  const label = children ?? meta?.title ?? to;
  return (
    <Link href={to} className={INLINE_LINK}>
      {label}
    </Link>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={INLINE_LINK}>
      {children}
      <span className="sr-only">{"(opens in a new tab)"}</span>
    </a>
  );
}
