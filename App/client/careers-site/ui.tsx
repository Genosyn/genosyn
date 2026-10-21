import React from "react";
import { Link } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { ArrowUpRight, Loader2 } from "lucide-react";

import { accentForeground } from "../../shared/recruiting";
import { hexToRgba } from "./lib";
import type { PublicSite } from "./types";

/**
 * The pieces every careers page is built from. The company's accent color is
 * a CSS variable set once at the root (`--accent`, `--accent-fg`,
 * `--accent-soft`), so every button, link and focus ring follows the brand
 * without a stylesheet per company.
 */

export function brandStyle(accent: string): React.CSSProperties {
  return {
    "--accent": accent,
    "--accent-fg": accentForeground(accent),
    "--accent-soft": hexToRgba(accent, 0.08),
    "--accent-ring": hexToRgba(accent, 0.35),
  } as React.CSSProperties;
}

export const accentButton =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-[color:var(--accent)] px-5 py-3 text-sm font-semibold text-[color:var(--accent-fg)] shadow-sm transition hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color:var(--accent-ring)] disabled:cursor-not-allowed disabled:opacity-60";

export const quietButton =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color:var(--accent-ring)]";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 aria-hidden className={`${className} animate-spin`} />;
}

/** Markdown a company wrote, sanitized before it touches the page. */
export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const html = React.useMemo(() => {
    const raw = marked.parse(source ?? "", { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [source]);
  return <div className={`careers-prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

export function SiteLogo({ site, size = "h-9 w-9" }: { site: PublicSite; size?: string }) {
  if (site.logoUrl) {
    return <img src={site.logoUrl} alt="" className={`${size} rounded-lg object-contain`} />;
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-[color:var(--accent)] text-sm font-semibold text-[color:var(--accent-fg)]`}
    >
      {initials(site.name)}
    </span>
  );
}

export function SiteHeader({ site }: { site: PublicSite }) {
  return (
    <header className="border-b border-slate-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
        <Link to="/" className="flex min-w-0 items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-4 focus-visible:ring-[color:var(--accent-ring)]">
          <SiteLogo site={site} />
          <span className="truncate text-base font-semibold text-slate-900">{site.name}</span>
          <span className="hidden text-base text-slate-400 sm:inline">Careers</span>
        </Link>
        {site.websiteUrl ? (
          <a
            href={site.websiteUrl}
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-slate-600 transition hover:text-slate-950"
          >
            {hostLabel(site.websiteUrl)}
            <ArrowUpRight aria-hidden className="h-4 w-4" />
          </a>
        ) : null}
      </div>
    </header>
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Website";
  }
}

export function SiteFooter({ site }: { site: PublicSite }) {
  return (
    <footer className="border-t border-slate-100">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>
          © {new Date().getFullYear()} {site.name}
        </span>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {site.privacyPolicyUrl ? (
            <a href={site.privacyPolicyUrl} className="hover:text-slate-800">
              Privacy
            </a>
          ) : null}
          {site.websiteUrl ? (
            <a href={site.websiteUrl} className="hover:text-slate-800">
              {hostLabel(site.websiteUrl)}
            </a>
          ) : null}
          <a href="https://genosyn.com" className="text-slate-400 hover:text-slate-700">
            Powered by Genosyn
          </a>
        </div>
      </div>
    </footer>
  );
}

/** A centered message page: not found, members only, a failed load. */
export function MessagePage({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-5 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
      <p className="mt-3 text-base text-slate-600">{body}</p>
      {action ? <div className="mt-8">{action}</div> : null}
    </main>
  );
}

export function LoadingPage() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center text-slate-400" role="status">
      <Spinner className="h-6 w-6" />
      <span className="sr-only">Loading</span>
    </main>
  );
}

export function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={
        tone === "accent"
          ? "inline-flex items-center rounded-full bg-[color:var(--accent-soft)] px-3 py-1 text-xs font-medium text-[color:var(--accent)]"
          : "inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
      }
    >
      {children}
    </span>
  );
}
