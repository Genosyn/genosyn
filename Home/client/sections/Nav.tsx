import { useEffect, useState } from "react";
import { Github, Menu, X } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

const LINKS = [
  { href: "/products", label: "Products" },
  { href: "/products/ai-employees", label: "AI Employees" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "/enterprise", label: "Enterprise" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition ${
        scrolled
          ? "border-slate-200/90 bg-white/90 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-xl"
          : "border-slate-200/80 bg-white"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-5 sm:px-6">
        <Link href="/" className="flex items-center text-slate-950" aria-label="Genosyn home">
          <Logo className="h-7 w-auto" />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 w-9 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 sm:inline-flex"
            aria-label="Genosyn on GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
          <a
            href="/#quickstart"
            className="hidden items-center rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition hover:-translate-y-px hover:bg-slate-800 sm:inline-flex"
          >
            Install
          </a>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label="Toggle navigation"
            aria-expanded={open}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-700 transition hover:bg-slate-50 md:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-200 bg-white md:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1 px-5 py-4" aria-label="Mobile navigation">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2.5 text-sm font-medium text-slate-700"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
            <a
              href="/#quickstart"
              onClick={() => setOpen(false)}
              className="mt-1 inline-flex items-center justify-center rounded-md bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white"
            >
              Install Genosyn
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
