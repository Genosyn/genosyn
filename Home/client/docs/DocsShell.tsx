import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { DocsNav } from "@/docs/DocsNav";
import { DOCS_FLAT, DOCS_NAV, type DocsPageMeta } from "@/docs/nav";
import { Container, Field, TextLink } from "@/sections/Kit";
import { GITHUB_URL } from "@/lib/constants";

/** The documentation reading measure stays comfortable beside the app-like rail. */
const MEASURE = "max-w-3xl";

const DOCS_SOURCE_BASE = `${GITHUB_URL}/blob/main/Home/client/docs/pages`;

const PATH_TO_SOURCE: Record<string, string> = {
  "/docs": "Introduction.tsx",
  "/docs/install": "Install.tsx",
  "/docs/getting-started": "GettingStarted.tsx",
  "/docs/help": "Help.tsx",
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
  "/docs/workspace-chat": "WorkspaceChat.tsx",
  "/docs/tldrs": "Tldrs.tsx",
  "/docs/decisions": "Decisions.tsx",
  "/docs/goals": "Goals.tsx",
  "/docs/verification": "Verification.tsx",
  "/docs/improvement": "Improvement.tsx",
  "/docs/autonomy": "Autonomy.tsx",
  "/docs/standdowns": "Standdowns.tsx",
  "/docs/policies": "Policies.tsx",
  "/docs/reactivity": "Reactivity.tsx",
  "/docs/vault": "Vault.tsx",
  "/docs/vault-sources": "VaultSources.tsx",
  "/docs/plans-billing": "PlansBilling.tsx",
  "/docs/enterprise-license": "EnterpriseLicense.tsx",
  "/docs/self-hosting": "SelfHosting.tsx",
  "/docs/saas-hosting": "SaasHosting.tsx",
  "/docs/cli": "Cli.tsx",
  "/docs/vocabulary": "Vocabulary.tsx",
};

export function DocsShell({ pathname, children }: { pathname: string; children: ReactNode }) {
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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const idx = DOCS_FLAT.findIndex((p) => p.path === pathname);
  const prev = idx > 0 ? DOCS_FLAT[idx - 1] : null;
  const next = idx >= 0 && idx < DOCS_FLAT.length - 1 ? DOCS_FLAT[idx + 1] : null;
  const sourceFile = PATH_TO_SOURCE[pathname];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-700">
      <DocsNav onToggleSidebar={() => setOpen((v) => !v)} sidebarOpen={open} />

      <Container>
        <div className="flex flex-col lg:flex-row">
          <aside
            id="docs-sidebar"
            aria-label="Documentation sections"
            className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform overflow-y-auto border-r border-slate-200 bg-white px-4 pb-10 pt-[4.5rem] shadow-xl transition-transform duration-150 lg:sticky lg:top-14 lg:z-auto lg:block lg:h-[calc(100vh-3.5rem)] lg:w-64 lg:max-w-none lg:flex-shrink-0 lg:translate-x-0 lg:px-0 lg:pb-14 lg:pr-6 lg:pt-8 lg:shadow-none ${
              open ? "block translate-x-0" : "hidden -translate-x-full"
            }`}
          >
            <SidebarTree pathname={pathname} />
          </aside>

          {open && (
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
            />
          )}

          <main className="min-w-0 flex-1 pb-24 pt-8 lg:pl-10 lg:pt-10">
            <article className={MEASURE}>{children}</article>

            <div className={`mt-16 ${MEASURE}`}>
              <PrevNext prev={prev} next={next} />
              <SourceLink file={sourceFile} />
            </div>
          </main>
        </div>
      </Container>

      <DocsFooter />
    </div>
  );
}

/** Contextual navigation with the same selected state as the product sidebar. */
function SidebarTree({ pathname }: { pathname: string }) {
  return (
    <nav className="space-y-6">
      {DOCS_NAV.map((section) => (
        <div key={section.label}>
          <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {section.label}
          </div>
          <ul className="mt-2 space-y-1">
            {section.pages.map((page) => {
              const active = page.path === pathname;
              return (
                <li key={page.path}>
                  <Link
                    href={page.path}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-3 py-2 text-sm leading-snug transition-colors duration-150 ${
                      active
                        ? "bg-indigo-50 font-medium text-indigo-700"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
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

function PrevNext({ prev, next }: { prev: DocsPageMeta | null; next: DocsPageMeta | null }) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Documentation pagination" className="grid gap-3 sm:grid-cols-2">
      {prev ? <PageStep page={prev} direction="Previous" /> : <span className="hidden sm:block" />}
      {next ? <PageStep page={next} direction="Next" align="right" /> : null}
    </nav>
  );
}

function PageStep({
  page,
  direction,
  align = "left",
}: {
  page: DocsPageMeta;
  direction: string;
  align?: "left" | "right";
}) {
  return (
    <Link
      href={page.path}
      className={`group block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50 ${
        align === "right" ? "sm:text-right" : ""
      }`}
    >
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {direction}
      </span>
      <span className="mt-2 block text-[0.9375rem] font-medium leading-snug text-slate-900 group-hover:text-indigo-700">
        {page.title}
      </span>
    </Link>
  );
}

function SourceLink({ file }: { file?: string }) {
  if (!file) return null;
  return (
    <div className="mt-12">
      <TextLink href={`${DOCS_SOURCE_BASE}/${file}`} external>
        Edit this page on GitHub
      </TextLink>
    </div>
  );
}

function DocsFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <Container className="flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
        <Field>{`© ${__BUILD_YEAR__} HACKERBAY, INC.`}</Field>
        <nav
          aria-label="Site"
          className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:justify-end"
        >
          <FooterLink href="/">Home</FooterLink>
          <FooterLink href="/docs">Docs</FooterLink>
          <FooterLink href={GITHUB_URL} external>
            GitHub
          </FooterLink>
          <a
            href="/install.sh"
            className="t-data text-[11px] leading-4 text-slate-500 transition-colors duration-150 hover:text-slate-900"
          >
            install.sh
          </a>
          <Field>{`v${__APP_VERSION__}`}</Field>
        </nav>
      </Container>
    </footer>
  );
}

function FooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  const className = "t-field text-slate-500 transition-colors duration-150 hover:text-slate-900";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
        <span className="sr-only">{"(opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
