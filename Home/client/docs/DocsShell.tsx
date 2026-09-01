import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { DocsNav } from "@/docs/DocsNav";
import { DOCS_FLAT, DOCS_NAV, type DocsPageMeta } from "@/docs/nav";
import { Container, Field, TextLink } from "@/sections/Kit";
import { GITHUB_URL } from "@/lib/constants";

/**
 * The docs chrome.
 *
 * Same brief as Prose.tsx: the palette and the type, none of the furniture.
 * There is no rail here and no sheet number, because the reader did not come
 * to look at the document — they came to find one paragraph in it. What the
 * shell owes them is a measure they can read, a sidebar that says where they
 * are, and nothing that moves.
 *
 * Three things changed beyond the repaint. The container is the site's own
 * 82rem with the same clamped inline padding, so the docs sit on the measure
 * the marketing pages sit on. The sidebar carries one continuous vertical
 * hairline down its right edge, which is the nearest thing to the rail a
 * reading surface should have — it separates, it does not announce. And
 * lucide-react is gone from this file: the previous/next arrows and the GitHub
 * glyph are words now, which is the site-wide rule and which also means the
 * two controls read at 375px, where a 12px chevron did not.
 */

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

  // Escape closes the drawer, matching sections/Nav.tsx. A panel that covers
  // the page and can only be dismissed by pointing at the 4% of it that is not
  // covered is not a keyboard-reachable control.
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
    <div className="min-h-screen bg-paper-100 text-zinc-700">
      <DocsNav onToggleSidebar={() => setOpen((v) => !v)} sidebarOpen={open} />

      {/* The measure comes from the Kit's `Container` rather than from a
          hand-written 82rem, because a second copy of the site's one width is
          how two measures end up on one site. */}
      <Container>
        <div className="flex flex-col lg:flex-row">
          <aside
            id="docs-sidebar"
            aria-label="Documentation sections"
            className={`fixed inset-y-0 left-0 z-40 w-72 transform overflow-y-auto border-r border-paper-400 bg-paper-100 px-6 pb-10 pt-[4.5rem] transition-transform duration-150 lg:sticky lg:top-14 lg:z-auto lg:h-[calc(100vh-3.5rem)] lg:w-60 lg:flex-shrink-0 lg:translate-x-0 lg:border-paper-300 lg:px-0 lg:pb-14 lg:pr-8 lg:pt-12 ${
              open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
            }`}
          >
            <SidebarTree pathname={pathname} />
          </aside>

          {open && (
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 bg-zinc-950/40 lg:hidden"
            />
          )}

          <main className="min-w-0 flex-1 py-10 pb-24 lg:py-12 lg:pl-10">
            <article className="max-w-[46rem]">{children}</article>

            <div className="mt-16 max-w-[46rem]">
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

/**
 * The sidebar tree.
 *
 * The active page used to be a filled, rounded chip. It is now a near-black
 * rule in the left margin against the hairline every other item sits on, which
 * is the same hair-versus-structural distinction `Rule` draws in the Kit: the
 * one line that means something is the one you can see.
 */
function SidebarTree({ pathname }: { pathname: string }) {
  return (
    <nav className="space-y-8">
      {DOCS_NAV.map((section) => (
        <div key={section.label}>
          <div className="t-cond text-[11px] uppercase tracking-field text-zinc-600">
            {section.label}
          </div>
          <ul className="mt-3 border-l border-paper-300">
            {section.pages.map((page) => {
              const active = page.path === pathname;
              return (
                <li key={page.path}>
                  <Link
                    href={page.path}
                    aria-current={active ? "page" : undefined}
                    className={`-ml-px block border-l py-1.5 pl-3 text-[14px] leading-snug transition-colors ${
                      active
                        ? "border-zinc-950 text-zinc-950"
                        : "border-transparent text-zinc-700 hover:border-paper-400 hover:text-zinc-950"
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

/**
 * Previous and next.
 *
 * Two bordered white cards with drop shadows became two rows under one rule.
 * The direction is a word rather than a chevron — `ArrowEast` exists for a
 * rightward arrow, but there is no westward mark and inventing one to label a
 * control that already says "Previous" is furniture.
 */
function PrevNext({ prev, next }: { prev: DocsPageMeta | null; next: DocsPageMeta | null }) {
  if (!prev && !next) return null;
  return (
    <nav aria-label="Documentation pagination" className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
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
      className={`group block border-t border-paper-400 pt-4 ${
        align === "right" ? "sm:text-right" : ""
      }`}
    >
      <span className="t-cond block text-[11px] uppercase tracking-field text-zinc-600">
        {direction}
      </span>
      <span className="mt-2 block text-[0.9375rem] font-semibold leading-snug text-zinc-950 underline decoration-transparent underline-offset-[3px] transition-colors group-hover:decoration-zinc-950">
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
    <footer className="border-t border-paper-400 bg-paper-200">
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
            className="t-data text-[11px] leading-4 text-zinc-600 transition-colors hover:text-zinc-950"
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
  const className =
    "t-cond text-[11px] uppercase tracking-field text-zinc-600 transition-colors hover:text-zinc-950";
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
        <span className="sr-only">{" (opens in a new tab)"}</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
