import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";
import { Container } from "@/sections/Kit";

/**
 * The docs header.
 *
 * It no longer restyles itself at a scroll threshold. The old version watched
 * `window.scrollY` and swapped a transparent border for a hairline plus a
 * backdrop blur eight pixels in, which cost a scroll listener, a state hook
 * and a render on every page — to communicate that the reader had scrolled,
 * which they already knew. sections/Nav.tsx makes the same argument about the
 * fascia and it applies here: a header that changes skin is a website
 * pretending to be a machine.
 *
 * The icons went with it. `Menu` / `X` are the words "Menu" and "Close", the
 * GitHub glyph is the word "GitHub", and both are set in the condensed
 * uppercase the site uses for every other control. That is the same set of
 * labels sections/Nav.tsx carries, so the two headers now speak once.
 *
 * It sits on the Kit's `Container` rather than on a hand-written 82rem with
 * its own clamped padding. DocsShell already puts the sidebar and the reading
 * column inside `Container`, so the two widths disagreed by several rem and
 * the wordmark did not line up with the sidebar underneath it — a misalignment
 * that is invisible in a diff and impossible to unsee on the page.
 *
 * The bottom edge is the structural rule rather than a hairline. This header
 * is sticky over a reading column, so it is the one boundary on the docs that
 * has prose sliding underneath it, and 1.22:1 is not enough to stop a
 * paragraph ghosting into the header as it goes.
 */
export function DocsNav({
  onToggleSidebar,
  sidebarOpen,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-rule bg-ground">
      <Container className="flex h-14 items-center gap-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle docs sidebar"
          aria-expanded={sidebarOpen}
          aria-controls="docs-sidebar"
          className="t-field rounded-control border border-rule px-3 py-2.5 text-ink transition-colors hover:bg-ink hover:text-ground lg:hidden"
        >
          {sidebarOpen ? "Close" : "Menu"}
        </button>

        <Link
          href="/"
          className="flex items-center text-ink transition-opacity hover:opacity-70"
          aria-label="Genosyn home"
        >
          <Logo className="text-[15px]" />
        </Link>

        <span className="hidden text-muted sm:inline" aria-hidden>
          /
        </span>
        <Link
          href="/docs"
          className="t-field hidden text-[12px] text-ink2 transition-colors hover:text-ink sm:inline"
        >
          Docs
        </Link>

        <div className="ml-auto flex items-center gap-5">
          <Link
            href="/docs/install"
            className="t-field hidden text-[12px] text-ink2 transition-colors hover:text-ink sm:inline"
          >
            Install
          </Link>
          {/* The `aria-label="GitHub"` this carried is gone on purpose: the
              label is now visible text, and an aria-label would have replaced
              the accessible name wholesale and swallowed the new-tab notice
              underneath it. */}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="t-field text-[12px] text-ink2 transition-colors hover:text-ink"
          >
            GitHub
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>
          <Link
            href="/"
            className="t-field rounded-control hidden bg-ink px-4 py-2.5 text-[12px] text-ground transition-colors hover:bg-ink2 sm:inline-flex"
          >
            Back to site
          </Link>
        </div>
      </Container>
    </header>
  );
}
