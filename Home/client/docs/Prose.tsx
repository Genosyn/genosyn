import type { ReactNode } from "react";
import { findPageMeta } from "@/docs/nav";
import { Link } from "@/lib/router";

type WithId = { children: ReactNode; id?: string };

export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
}) {
  return (
    <header className="border-b border-zinc-100 pb-8">
      {eyebrow && (
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
          {eyebrow}
        </div>
      )}
      <h1 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.025em] text-zinc-950 sm:text-[2.75rem]">
        {title}
      </h1>
      {lead && (
        <p className="mt-5 max-w-3xl text-balance text-lg leading-relaxed text-zinc-600">
          {lead}
        </p>
      )}
    </header>
  );
}

export function H2({ children, id }: WithId) {
  return (
    <h2
      id={id}
      className="mt-14 scroll-mt-24 text-balance text-2xl font-semibold tracking-[-0.015em] text-zinc-950"
    >
      {children}
    </h2>
  );
}

export function H3({ children, id }: WithId) {
  return (
    <h3
      id={id}
      className="mt-8 scroll-mt-24 text-lg font-semibold text-zinc-950"
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 text-[15px] leading-[1.75] text-zinc-700">
      {children}
    </p>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-zinc-950">{children}</span>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-4 ml-5 list-disc space-y-2 text-[15px] leading-[1.7] text-zinc-700 marker:text-zinc-400">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="mt-4 ml-5 list-decimal space-y-2 text-[15px] leading-[1.7] text-zinc-700 marker:text-zinc-400">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[12.5px] text-zinc-800">
      {children}
    </code>
  );
}

export function Pre({
  children,
  lang,
}: {
  children: ReactNode;
  lang?: string;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-zinc-900 bg-zinc-950 shadow-card">
      {lang && (
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          <span>{lang}</span>
        </div>
      )}
      <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.7] text-zinc-200">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Callout({
  children,
  kind = "info",
  title,
}: {
  children: ReactNode;
  kind?: "info" | "warn" | "tip";
  title?: string;
}) {
  const tone = {
    info: "border-zinc-200 bg-zinc-50 text-zinc-700",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    tip: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[kind];
  const titleColor = {
    info: "text-zinc-950",
    warn: "text-amber-950",
    tip: "text-emerald-950",
  }[kind];
  return (
    <aside
      className={`mt-6 rounded-xl border px-4 py-3 text-[14px] leading-[1.65] ${tone}`}
    >
      {title && (
        <div className={`mb-1 text-sm font-semibold ${titleColor}`}>
          {title}
        </div>
      )}
      {children}
    </aside>
  );
}

export function KeyList({
  rows,
}: {
  rows: Array<{ term: string; def: ReactNode }>;
}) {
  return (
    <dl className="mt-6 divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
      {rows.map((r) => (
        <div
          key={r.term}
          className="grid grid-cols-1 gap-1 px-5 py-4 sm:grid-cols-[180px_1fr] sm:gap-6"
        >
          <dt className="font-mono text-[12.5px] text-zinc-500">{r.term}</dt>
          <dd className="text-[14.5px] leading-[1.65] text-zinc-700">
            {r.def}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DocLink({
  to,
  children,
}: {
  to: string;
  children?: ReactNode;
}) {
  const meta = findPageMeta(to);
  const label = children ?? meta?.title ?? to;
  return (
    <Link
      href={to}
      className="font-medium text-zinc-950 underline decoration-zinc-300 decoration-1 underline-offset-2 hover:decoration-zinc-700"
    >
      {label}
    </Link>
  );
}

export function ExtLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-zinc-950 underline decoration-zinc-300 decoration-1 underline-offset-2 hover:decoration-zinc-700"
    >
      {children}
    </a>
  );
}
