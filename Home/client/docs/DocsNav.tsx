import { useEffect, useState } from "react";
import { Github, Menu, X } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

export function DocsNav({
  onToggleSidebar,
  sidebarOpen,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-all ${
        scrolled
          ? "border-b border-zinc-200/70 bg-white/85 backdrop-blur"
          : "border-b border-zinc-100 bg-white"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6 lg:px-8">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle docs sidebar"
          aria-expanded={sidebarOpen}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50 lg:hidden"
        >
          {sidebarOpen ? (
            <X className="h-4 w-4" />
          ) : (
            <Menu className="h-4 w-4" />
          )}
        </button>

        <Link href="/" className="flex items-center text-zinc-950" aria-label="Genosyn home">
          <Logo className="h-7 w-auto" />
        </Link>

        <span className="hidden text-zinc-300 sm:inline" aria-hidden>
          /
        </span>
        <Link
          href="/docs"
          className="hidden text-sm font-medium text-zinc-700 hover:text-zinc-950 sm:inline"
        >
          Docs
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/docs/install"
            className="hidden items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950 sm:inline-flex"
          >
            Install
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-50 hover:text-zinc-950"
            aria-label="GitHub"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <Link
            href="/"
            className="hidden items-center gap-1.5 rounded-md bg-zinc-950 px-3.5 py-1.5 text-sm font-semibold text-white shadow-card transition hover:bg-zinc-800 sm:inline-flex"
          >
            Back to site
          </Link>
        </div>
      </div>
    </header>
  );
}
