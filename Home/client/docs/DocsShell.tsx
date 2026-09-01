import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { DocsNav } from "@/docs/DocsNav";
import { DOCS_FLAT, DOCS_NAV, type DocsPageMeta } from "@/docs/nav";
import { Container, DEPT_FULL, Field, TextLink, type Dept } from "@/sections/Kit";
import { GITHUB_URL } from "@/lib/constants";

/**
 * The docs chrome.
 *
 * Same brief as Prose.tsx: the palette and the type, none of the marketing
 * furniture. The reader did not come to look at the document — they came to
 * find one paragraph in it. What the shell owes them is a measure they can
 * read, a sidebar that says where they are, and nothing that moves.
 *
 * **The one place a department hue is allowed in the docs is the sidebar.**
 *
 * That is not a licence to decorate; it is the org chart being literally true
 * here. Four of the ten nav sections are named after departments —
 * Engineering, Marketing, Revenue, Operations — and a reader who has decoded
 * the wall on the landing page already knows what those hues mean, so
 * repeating them in the sidebar is the legend paying off rather than a second
 * use of the same colour. The remaining six sections get no hue at all,
 * because inventing one for "Reference" would make a hue mean *a section*, and
 * a hue means a department or it means nothing.
 *
 * The inversion survives the move. The section you are standing in is drawn in
 * its department colour at the Kit's 3px edge weight; the one page inside it
 * that is actually open is drawn in ink, over the top of that colour. So the
 * sidebar makes the same argument the wall does at the same glance: the
 * machine is in colour, and the black mark is where the person is.
 */

/**
 * The measure, and it is the one number in this file worth arguing about.
 *
 * It was 46rem carrying 15px prose — a little over a hundred characters a
 * line, which is a wall rather than a column, and the reason the docs were
 * tiring to read at a laptop width even though every token in them was right.
 * 41rem at 16px is about seventy-eight, which is the top of the range a
 * two-column-free reading surface can hold without the eye losing the return
 * sweep.
 *
 * `Pre` and `KeyList` share it rather than breaking out wider. A code block
 * that escapes the measure is the one element on the page that starts at a
 * different left edge on every scroll, and a `<pre>` that scrolls on its own
 * axis already solves the only problem the extra width would have solved.
 */
const MEASURE = "max-w-[41rem]";

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
    <div className="min-h-screen bg-ground text-ink2">
      <DocsNav onToggleSidebar={() => setOpen((v) => !v)} sidebarOpen={open} />

      {/* The measure comes from the Kit's `Container` rather than from a
          hand-written 82rem, because a second copy of the site's one width is
          how two measures end up on one site. */}
      <Container>
        <div className="flex flex-col lg:flex-row">
          <aside
            id="docs-sidebar"
            aria-label="Documentation sections"
            className={`fixed inset-y-0 left-0 z-40 w-72 transform overflow-y-auto border-r border-rule bg-ground px-6 pb-10 pt-[4.5rem] transition-transform duration-150 lg:sticky lg:top-14 lg:z-auto lg:h-[calc(100vh-3.5rem)] lg:w-60 lg:flex-shrink-0 lg:translate-x-0 lg:border-hairline lg:px-0 lg:pb-14 lg:pr-8 lg:pt-12 ${
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
              className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
            />
          )}

          <main className="min-w-0 flex-1 py-10 pb-24 lg:py-12 lg:pl-10">
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

/**
 * Which department does a nav section belong to?
 *
 * Four of the ten sections carry a department's name, and those four get
 * that department's hue — the same hue the wall on the landing page gave them,
 * because a hue that meant Revenue there and something else here would not be
 * a legend, it would be a palette.
 *
 * The other six are absent on purpose. "Get started", "Core concepts",
 * "Brains & tools", "Analytics", "Self-hosting" and "Reference" are shapes of
 * documentation rather than parts of a company, and `people` — the eighth hue
 * — is reserved for /roles/recruiter and is not spendable here. They fall
 * through to the structural rule, which is a neutral that clears 1.4.11 and
 * says the honest thing: this section is where you are, and it is not a
 * department.
 *
 * Keyed by the label in nav.ts, which this file may not edit. A renamed
 * section therefore falls out of the map rather than breaking, and falls back
 * to the neutral — which is the failure worth having, because the alternative
 * is a section quietly wearing another department's hue.
 *
 * The value type says `| undefined` on purpose. `Record<string, Dept>` claims
 * every label resolves, which is false for six of the ten and would let the
 * next `DEPT_FULL[SECTION_DEPT[label]]` type-check and then emit
 * `bg-undefined` — a spine that silently stops drawing. Spelling the miss into
 * the type is what makes the fallback above a guarantee rather than a habit.
 */
const SECTION_DEPT: Record<string, Dept | undefined> = {
  Engineering: "repositories",
  Marketing: "marketing",
  Revenue: "revenue",
  Operations: "operations",
};

/**
 * The sidebar tree.
 *
 * Two marks, and they are the whole system in eight inches of column.
 *
 * The **section** you are reading in takes a 3px spine down its page list, in
 * its department hue where it has one — the same weight as the department edge
 * on a `Pane` and the same weight as a `Row` spine, so it reads as the Kit
 * rather than as a sidebar convention. Every other section keeps a 1px
 * hairline, which aligns the list and means nothing.
 *
 * The **page** you have open takes a 3px ink mark on top of that spine. It
 * used to be a filled rounded chip, and then a 1px black border, and it is now
 * the heaviest neutral on the page laid over the department colour, because
 * that is the inversion: seven hues working away, one black mark, and the black
 * mark is you. It is also why the active page keeps `aria-current="page"` —
 * the colour is the fast channel, not the only one.
 *
 * Both spines are absolutely positioned rather than left borders, exactly as
 * `Row` and `Pane` do it in the Kit, so a 1px section and a 3px one share the
 * same text edge instead of shifting every title by two pixels when the reader
 * moves between sections.
 */
function SidebarTree({ pathname }: { pathname: string }) {
  return (
    <nav className="space-y-8">
      {DOCS_NAV.map((section) => {
        const here = section.pages.some((page) => page.path === pathname);
        const dept = SECTION_DEPT[section.label];
        const spine = here ? `w-[3px] ${dept ? DEPT_FULL[dept] : "bg-rule"}` : "w-px bg-hairline";
        return (
          <div key={section.label}>
            <div className="t-field text-muted">{section.label}</div>
            <div className="relative mt-3">
              <span aria-hidden className={`absolute inset-y-0 left-0 ${spine}`} />
              <ul className="pl-4">
                {section.pages.map((page) => {
                  const active = page.path === pathname;
                  return (
                    <li key={page.path} className="relative">
                      {active && (
                        <span aria-hidden className="absolute inset-y-0 -left-4 w-[3px] bg-ink" />
                      )}
                      <Link
                        href={page.path}
                        aria-current={active ? "page" : undefined}
                        className={`block py-1.5 text-[14px] leading-snug transition-colors ${
                          active ? "font-semibold text-ink" : "text-ink2 hover:text-ink"
                        }`}
                      >
                        {page.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        );
      })}
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
      className={`group block border-t border-rule pt-4 ${
        align === "right" ? "sm:text-right" : ""
      }`}
    >
      <span className="t-field block text-muted">{direction}</span>
      {/* `decoration-zinc-950` was a dead class after the token swap, so the
          hover underline never drew at all. It is `ink` now, and the resting
          state stays transparent so the pair reads as two titles under a rule
          rather than as two links. */}
      <span className="mt-2 block text-[0.9375rem] font-semibold leading-snug text-ink underline decoration-transparent underline-offset-[3px] transition-colors group-hover:decoration-ink">
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
    <footer className="border-t border-rule bg-ground">
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
            className="t-data text-[11px] leading-4 text-muted transition-colors hover:text-ink"
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
  // `t-field` already sets 11px and uppercase; restating them was the kind of
  // duplication that lets one of the two drift.
  const className = "t-field text-muted transition-colors hover:text-ink";
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
