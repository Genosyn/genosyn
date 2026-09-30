import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "@/lib/router";
import { DocsNav } from "@/docs/DocsNav";
import { DOCS_FLAT, DOCS_NAV, type DocsPageMeta } from "@/docs/nav";
import { TextLink } from "@/sections/Kit";
import { GITHUB_URL } from "@/lib/constants";
import "./DocsShell.css";

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
  const [mobile, setMobile] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 1023px)");
    const syncViewport = () => {
      setMobile(viewport.matches);
      if (!viewport.matches) setOpen(false);
    };
    syncViewport();
    viewport.addEventListener("change", syncViewport);
    return () => viewport.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (sidebar) sidebar.inert = mobile && !open;
  }, [mobile, open]);

  // Below `lg` the sidebar is a modal sheet: trap focus inside it, make the
  // rest of the page inert, and hand focus back when it closes.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const shell = shellRef.current;
    if (!open || !mobile || !sidebar || !shell) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const outside = [shell.querySelector("header"), mainRef.current, shell.querySelector("footer")]
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => ({ node, wasInert: node.inert }));

    outside.forEach(({ node }) => {
      node.inert = true;
    });
    document.body.style.overflow = "hidden";

    const focusable = () => Array.from(sidebar.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    const initialFocus = sidebar.querySelector<HTMLElement>('[aria-current="page"]') ?? focusable()[0];
    initialFocus?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      outside.forEach(({ node, wasInert }) => {
        node.inert = wasInert;
      });
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [mobile, open]);

  const idx = DOCS_FLAT.findIndex((p) => p.path === pathname);
  const prev = idx > 0 ? DOCS_FLAT[idx - 1] : null;
  const next = idx >= 0 && idx < DOCS_FLAT.length - 1 ? DOCS_FLAT[idx + 1] : null;
  const sourceFile = PATH_TO_SOURCE[pathname];

  return (
    <div ref={shellRef} className="min-h-screen bg-paper text-ink">
      <DocsNav onToggleSidebar={() => setOpen((v) => !v)} sidebarOpen={open} />
      <div className="mx-auto w-full max-w-[90rem] px-5 sm:px-8">
        <div className="flex flex-col lg:flex-row lg:gap-12 xl:gap-16">
          <aside
            ref={sidebarRef}
            id="docs-sidebar"
            aria-label="Documentation sections"
            aria-hidden={mobile && !open ? true : undefined}
            role={mobile && open ? "dialog" : undefined}
            aria-modal={mobile && open ? true : undefined}
            data-open={open}
            className="docs-sidebar scrollbar-none fixed inset-y-0 left-0 z-[60] w-[19rem] max-w-[85vw] overflow-y-auto border-r border-line bg-paper px-5 pb-10 pt-5 lg:sticky lg:top-16 lg:z-auto lg:h-[calc(100vh-4rem)] lg:w-60 lg:max-w-none lg:flex-shrink-0 lg:border-r-0 lg:bg-transparent lg:px-0 lg:pb-16 lg:pt-10"
          >
            <div className="mb-6 flex items-center justify-between gap-3 lg:hidden">
              <span className="font-display text-[1.3rem] text-ink">Documentation</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-9 rounded-full border border-line-strong px-4 text-[13px] font-medium text-ink transition-colors hover:bg-paper-raised"
              >
                Close
              </button>
            </div>
            <SidebarTree pathname={pathname} onNavigate={() => setOpen(false)} />
          </aside>

          <button
            type="button"
            aria-label="Close sidebar"
            aria-hidden={!open}
            tabIndex={-1}
            data-open={open}
            onClick={() => setOpen(false)}
            className="docs-backdrop fixed inset-0 z-50 bg-black/40 lg:hidden"
          />

          <main ref={mainRef} className="min-w-0 flex-1 pb-24 pt-10 lg:pt-14">
            <div className="flex gap-12 xl:gap-16">
              <article key={pathname} className="docs-article min-w-0 max-w-[44rem] flex-1">
                {children}
                <div className="mt-20">
                  <PrevNext prev={prev} next={next} />
                  {sourceFile && (
                    <div className="mt-10 border-t border-line pt-6">
                      <TextLink href={`${DOCS_SOURCE_BASE}/${sourceFile}`} external className="!text-[14px]">
                        Edit this page on GitHub
                      </TextLink>
                    </div>
                  )}
                </div>
              </article>
              <OnThisPage pathname={pathname} />
            </div>
          </main>
        </div>
      </div>
      <DocsFooter />
    </div>
  );
}

function SidebarTree({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  return (
    <nav className="space-y-8">
      {DOCS_NAV.map((section) => (
        <div key={section.label}>
          <p className="px-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-400">{section.label}</p>
          <ul className="mt-3 space-y-0.5">
            {section.pages.map((page) => {
              const active = page.path === pathname;
              return (
                <li key={page.path}>
                  <Link
                    href={page.path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-xl px-3 py-2 text-[14px] leading-snug transition-colors duration-150 ${
                      active ? "bg-ink font-medium text-white" : "text-ink-600 hover:bg-ink/[0.05] hover:text-ink"
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

type Heading = { id: string; text: string };

/**
 * "On this page": the article's H2s, read from the rendered page and
 * highlighted as they scroll past. Built after mount, so the prerendered
 * markup (which carries every heading anyway) is unaffected.
 */
function OnThisPage({ pathname }: { pathname: string }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLHeadingElement>(".docs-article h2[id]"));
    setHeadings(nodes.map((node) => ({ id: node.id, text: node.textContent ?? "" })));
    setActive(nodes[0]?.id ?? null);
    if (nodes.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [pathname]);

  if (headings.length < 2) return <div className="hidden w-52 shrink-0 xl:block" />;

  return (
    <nav aria-label="On this page" className="hidden w-52 shrink-0 xl:block">
      <div className="sticky top-28">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-400">On this page</p>
        <ul className="mt-4 space-y-1 border-l border-line">
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                className={`-ml-px block border-l py-1.5 pl-4 text-[13px] leading-snug transition-colors ${
                  active === heading.id ? "border-ink font-medium text-ink" : "border-transparent text-ink-500 hover:text-ink"
                }`}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
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
      className={`lift group block rounded-2xl border border-line bg-paper-raised p-5 hover:border-line-strong hover:shadow-soft ${
        align === "right" ? "sm:text-right" : ""
      }`}
    >
      <span
        className={`flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400 ${
          align === "right" ? "sm:justify-end" : ""
        }`}
      >
        {align === "left" && <ArrowLeft aria-hidden className="h-3.5 w-3.5" />}
        {direction}
        {align === "right" && <ArrowRight aria-hidden className="h-3.5 w-3.5" />}
      </span>
      <span className="mt-2.5 block font-display text-[1.3rem] leading-snug text-ink">{page.title}</span>
    </Link>
  );
}

function DocsFooter() {
  return (
    <footer className="border-t border-line bg-paper">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="text-[12.5px] text-ink-500">{`© ${__BUILD_YEAR__} HackerBay, Inc. · Genosyn v${__APP_VERSION__}`}</p>
        <nav aria-label="Site" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <FooterLink href="/">Home</FooterLink>
          <FooterLink href="/pricing">Pricing</FooterLink>
          <FooterLink href={GITHUB_URL} external>
            GitHub
          </FooterLink>
          <a href="/install.sh" className="font-mono text-[12px] text-ink-500 transition-colors hover:text-ink">
            install.sh
          </a>
        </nav>
      </div>
    </footer>
  );
}

function FooterLink({ href, external, children }: { href: string; external?: boolean; children: ReactNode }) {
  const className = "text-[13px] text-ink-500 transition-colors duration-150 hover:text-ink";
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
