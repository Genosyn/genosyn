import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

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
 */
export function DocsNav({
  onToggleSidebar,
  sidebarOpen,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-paper-400 bg-paper-100">
      <div className="mx-auto flex h-14 w-full max-w-[82rem] items-center gap-4 px-[clamp(1.25rem,4vw,3rem)]">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle docs sidebar"
          aria-expanded={sidebarOpen}
          aria-controls="docs-sidebar"
          className="t-cond border border-paper-400 px-3 py-2 text-[11px] uppercase tracking-field text-zinc-950 transition-colors hover:bg-zinc-950 hover:text-paper-50 lg:hidden"
        >
          {sidebarOpen ? "Close" : "Menu"}
        </button>

        <Link
          href="/"
          className="flex items-center text-zinc-950 transition-opacity hover:opacity-70"
          aria-label="Genosyn home"
        >
          <Logo className="text-[15px]" />
        </Link>

        <span className="hidden text-zinc-600 sm:inline" aria-hidden>
          /
        </span>
        <Link
          href="/docs"
          className="t-cond hidden text-[12px] uppercase tracking-field text-zinc-700 transition-colors hover:text-zinc-950 sm:inline"
        >
          Docs
        </Link>

        <div className="ml-auto flex items-center gap-5">
          <Link
            href="/docs/install"
            className="t-cond hidden text-[12px] uppercase tracking-field text-zinc-700 transition-colors hover:text-zinc-950 sm:inline"
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
            className="t-cond text-[12px] uppercase tracking-field text-zinc-700 transition-colors hover:text-zinc-950"
          >
            GitHub
            <span className="sr-only">{" (opens in a new tab)"}</span>
          </a>
          <Link
            href="/"
            className="t-cond hidden bg-zinc-950 px-4 py-2.5 text-[12px] uppercase tracking-field text-paper-50 transition-colors hover:bg-zinc-800 sm:inline-flex"
          >
            Back to site
          </Link>
        </div>
      </div>
    </header>
  );
}
