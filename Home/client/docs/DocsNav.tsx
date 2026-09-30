import { ArrowRight, Github, Menu, X } from "lucide-react";
import { GITHUB_URL, SIGN_IN_URL, SIGN_UP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

/** The docs header: the site mark, where you are, and the way back out. */
export function DocsNav({
  onToggleSidebar,
  sidebarOpen,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-paper">
      <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center gap-4 px-5 sm:px-8">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? "Close docs navigation" : "Open docs navigation"}
          aria-expanded={sidebarOpen}
          aria-controls="docs-sidebar"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line-strong text-ink transition-colors hover:bg-paper-raised lg:hidden"
        >
          {sidebarOpen ? <X aria-hidden className="h-4 w-4" /> : <Menu aria-hidden className="h-4 w-4" />}
        </button>
        <Link href="/" className="text-ink transition-opacity duration-150 hover:opacity-70" aria-label="Genosyn home">
          <Logo className="text-[14px] sm:text-[15px]" />
        </Link>
        <span aria-hidden className="hidden h-5 w-px bg-line-strong sm:block" />
        <Link href="/docs" className="hidden font-display text-[1.2rem] leading-none text-ink sm:inline">
          Docs
        </Link>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <span className="hidden font-mono text-[11px] text-ink-400 md:inline">{`v${__APP_VERSION__}`}</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden h-10 items-center gap-2 rounded-full px-3 text-[14px] text-ink-500 transition-colors hover:text-ink md:inline-flex"
          >
            <Github aria-hidden className="h-4 w-4" />
            GitHub
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>
          <a
            href={SIGN_IN_URL}
            className="hidden h-10 items-center rounded-full px-3 text-[14px] text-ink-500 transition-colors hover:text-ink sm:inline-flex"
          >
            Sign in
          </a>
          <a
            href={SIGN_UP_URL}
            className="press group inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-800"
          >
            Start free
            <ArrowRight aria-hidden className="nudge h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}
