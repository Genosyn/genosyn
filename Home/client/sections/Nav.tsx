import { useEffect, useState } from "react";
import { Github, Menu, X } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

// Hash links are home-page anchors; the `/#…` form keeps them working from
// nested routes like /products/* (they fall through to a full navigation).
const LINKS = [
  { href: "/#use-cases", label: "Use cases" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/products/ai-employees", label: "AI Employees" },
  { href: "/docs", label: "Docs" },
  { href: "/enterprise", label: "Enterprise" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
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
          ? "border-b border-zinc-200/70 bg-white/85 backdrop-blur-xl"
          : "border-b border-zinc-200/60 bg-[#f1f1eb]"
      }`}
    >
      <div className="mx-auto flex h-[4.5rem] max-w-[94rem] items-center justify-between gap-6 px-5 sm:px-6">
        <Link href="/" className="flex items-center text-zinc-950" aria-label="Genosyn">
          <Logo className="h-7 w-auto" />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-600 transition hover:bg-white/70 hover:text-zinc-950"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-zinc-600 transition hover:bg-white/70 hover:text-zinc-950 sm:inline-flex"
            aria-label="GitHub"
          >
            <Github className="h-4 w-4" />
            <span className="hidden xl:inline">GitHub</span>
          </a>
          <a
            href="/#quickstart"
            className="hidden items-center gap-1.5 rounded-xl bg-zinc-950 px-4 py-2.5 text-xs font-semibold text-white shadow-card transition hover:-translate-y-0.5 hover:bg-zinc-800 sm:inline-flex"
          >
            Self-host Genosyn
          </a>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 bg-white/70 text-zinc-700 hover:bg-white md:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-zinc-200 bg-white/95 backdrop-blur-xl md:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1 px-6 py-3">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {l.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
            <a
              href="/#quickstart"
              onClick={() => setOpen(false)}
              className="mt-1 inline-flex items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-sm font-semibold text-white"
            >
              Self-host Genosyn
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
