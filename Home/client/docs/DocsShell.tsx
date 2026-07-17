import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Github } from "lucide-react";
import { Link } from "@/lib/router";
import { DocsNav } from "@/docs/DocsNav";
import { DOCS_FLAT, DOCS_NAV, type DocsPageMeta } from "@/docs/nav";
import { GITHUB_URL } from "@/lib/constants";

const DOCS_SOURCE_BASE = `${GITHUB_URL}/blob/main/Home/client/docs/pages`;

const PATH_TO_SOURCE: Record<string, string> = {
  "/docs": "Introduction.tsx",
  "/docs/install": "Install.tsx",
  "/docs/employees": "Employees.tsx",
  "/docs/soul": "Soul.tsx",
  "/docs/skills": "Skills.tsx",
  "/docs/routines": "Routines.tsx",
  "/docs/tags": "Tags.tsx",
  "/docs/models": "Models.tsx",
  "/docs/open-source-models": "OpenSourceModels.tsx",
  "/docs/integrations": "Integrations.tsx",
  "/docs/explore": "Explore.tsx",
  "/docs/marketing": "Marketing.tsx",
  "/docs/self-hosting": "SelfHosting.tsx",
  "/docs/cli": "Cli.tsx",
  "/docs/vocabulary": "Vocabulary.tsx",
};

export function DocsShell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const idx = DOCS_FLAT.findIndex((p) => p.path === pathname);
  const prev = idx > 0 ? DOCS_FLAT[idx - 1] : null;
  const next = idx >= 0 && idx < DOCS_FLAT.length - 1 ? DOCS_FLAT[idx + 1] : null;
  const sourceFile = PATH_TO_SOURCE[pathname];

  return (
    <div className="min-h-screen bg-white text-zinc-950">
      <DocsNav onToggleSidebar={() => setOpen((v) => !v)} sidebarOpen={open} />

      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
          <aside
            aria-label="Documentation sections"
            className={`fixed inset-y-0 left-0 z-40 w-72 transform overflow-y-auto border-r border-zinc-200 bg-white px-6 pb-10 pt-20 transition-transform lg:sticky lg:top-16 lg:z-auto lg:h-[calc(100vh-4rem)] lg:w-60 lg:flex-shrink-0 lg:translate-x-0 lg:border-r-0 lg:px-0 lg:pb-12 lg:pt-10 ${
              open ? "translate-x-0 shadow-2xl" : "-translate-x-full lg:translate-x-0"
            }`}
          >
            <SidebarTree pathname={pathname} />
          </aside>

          {open && (
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 bg-zinc-900/30 lg:hidden"
            />
          )}

          <main className="min-w-0 flex-1 py-10 pb-24 lg:py-12">
            <article className="max-w-3xl">{children}</article>

            <div className="mt-16 max-w-3xl">
              <PrevNext prev={prev} next={next} />
              <SourceLink file={sourceFile} />
            </div>
          </main>
        </div>
      </div>

      <DocsFooter />
    </div>
  );
}

function SidebarTree({ pathname }: { pathname: string }) {
  return (
    <nav className="space-y-7 text-sm">
      {DOCS_NAV.map((section) => (
        <div key={section.label}>
          <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            {section.label}
          </div>
          <ul className="mt-2 space-y-0.5">
            {section.pages.map((page) => {
              const active = page.path === pathname;
              return (
                <li key={page.path}>
                  <Link
                    href={page.path}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1.5 text-[14px] leading-snug transition ${
                      active
                        ? "bg-zinc-100 font-medium text-zinc-950"
                        : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
                    }`}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function PrevNext({
  prev,
  next,
}: {
  prev: DocsPageMeta | null;
  next: DocsPageMeta | null;
}) {
  if (!prev && !next) return null;
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-zinc-100 pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          href={prev.path}
          className="group flex flex-col rounded-xl border border-zinc-200 bg-white px-5 py-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
        >
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            <ArrowLeft className="h-3 w-3" />
            Previous
          </span>
          <span className="mt-2 text-[15px] font-semibold text-zinc-950">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.path}
          className="group flex flex-col items-end rounded-xl border border-zinc-200 bg-white px-5 py-4 text-right shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
        >
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
            Next
            <ArrowRight className="h-3 w-3" />
          </span>
          <span className="mt-2 text-[15px] font-semibold text-zinc-950">
            {next.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

function SourceLink({ file }: { file?: string }) {
  if (!file) return null;
  return (
    <div className="mt-8 text-xs text-zinc-500">
      <a
        href={`${DOCS_SOURCE_BASE}/${file}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 hover:text-zinc-700"
      >
        <Github className="h-3.5 w-3.5" />
        Edit this page on GitHub
      </a>
    </div>
  );
}

function DocsFooter() {
  return (
    <footer className="border-t border-zinc-100 bg-white">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-zinc-500 sm:flex-row lg:px-8">
        <div>© {__BUILD_YEAR__} HackerBay, Inc. · Built in the open.</div>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <Link href="/" className="hover:text-zinc-900">
            Home
          </Link>
          <Link href="/docs" className="hover:text-zinc-900">
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-zinc-900"
          >
            GitHub
          </a>
          <a href="/install.sh" className="hover:text-zinc-900">
            install.sh
          </a>
          <span className="font-mono text-zinc-400">v{__APP_VERSION__}</span>
        </nav>
      </div>
    </footer>
  );
}
