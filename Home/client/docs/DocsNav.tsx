import { GITHUB_URL } from "@/lib/constants";
import { Logo, LogoMark } from "@/components/Logo";
import { Link } from "@/lib/router";
import { Container } from "@/sections/Kit";

/** The documentation header shares the app's compact 56px navigation frame. */
export function DocsNav({
  onToggleSidebar,
  sidebarOpen,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white">
      <Container className="flex h-14 items-center gap-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle docs sidebar"
          aria-expanded={sidebarOpen}
          aria-controls="docs-sidebar"
          className="inline-flex min-h-9 items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors duration-150 hover:bg-slate-50 lg:hidden"
        >
          {sidebarOpen ? "Close" : "Menu"}
        </button>

        <Link
          href="/"
          className="flex items-center text-slate-900 transition-opacity duration-150 hover:opacity-75"
          aria-label="Genosyn home"
        >
          <LogoMark className="h-7 w-7 sm:hidden" />
          <Logo className="hidden text-[15px] sm:block" />
        </Link>

        <span className="hidden text-slate-300 sm:inline" aria-hidden>
          /
        </span>
        <Link
          href="/docs"
          className="hidden text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 sm:inline"
        >
          Docs
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <span className="tabular hidden text-[11px] text-slate-500 md:inline">
            {`v${__APP_VERSION__}`}
          </span>
          <Link
            href="/docs/install"
            className="hidden rounded-md px-2.5 py-2 text-sm font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-900 sm:inline-flex"
          >
            Install
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-2.5 py-2 text-sm font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-900"
          >
            GitHub
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>
          <Link
            href="/"
            className="hidden min-h-9 items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-indigo-700 sm:inline-flex"
          >
            Back to site
          </Link>
        </div>
      </Container>
    </header>
  );
}
