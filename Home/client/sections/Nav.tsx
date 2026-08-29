import { useEffect, useState } from "react";
import { ArrowRight, Github, Menu, X } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link } from "@/lib/router";

const LINKS = [
  { href: "/#autonomy", label: "Autonomy" },
  { href: "/products", label: "Products" },
  { href: "/products/ai-employees", label: "AI Employees" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
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
      className={`sticky top-0 z-50 transition duration-300 ${
        scrolled
          ? "border-b border-stone-900/[0.08] bg-paper-50/85 shadow-[0_1px_2px_rgba(60,40,25,0.05)] backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[88rem] items-center justify-between gap-6 px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center text-stone-900 transition hover:opacity-70"
          aria-label="Genosyn home"
        >
          <Logo className="h-7 w-auto" />
        </Link>

        {/* lg, not md: six links plus the GitHub icon and the Install button
            need ~730px next to the logo, so at 768px the row used to wrap
            "AI Employees" onto two lines and push Install past the right edge.
            The menu button covers 768-1023px instead. */}
        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Primary navigation">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-900/[0.04] hover:text-stone-900"
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
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-stone-900/[0.04] hover:text-stone-900 sm:inline-flex"
            aria-label="Genosyn on GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
          <a
            href="/#quickstart"
            className="group hidden items-center gap-1.5 rounded-xl bg-flame-500 px-4 py-2 text-sm font-semibold text-white shadow-card transition duration-200 hover:bg-flame-600 sm:inline-flex"
          >
            Install
            <ArrowRight
              aria-hidden
              className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"
            />
          </a>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label="Toggle navigation"
            aria-expanded={open}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stone-900/[0.12] bg-white text-stone-700 transition hover:border-stone-900/20 hover:text-stone-900 lg:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-stone-900/[0.08] bg-paper-50/95 backdrop-blur-xl lg:hidden">
          <nav
            className="mx-auto flex max-w-[88rem] flex-col gap-1 px-5 py-4 sm:px-8"
            aria-label="Mobile navigation"
          >
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-stone-700 transition hover:bg-stone-900/[0.04] hover:text-stone-900"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-2 rounded-xl border border-stone-900/[0.12] bg-white px-3 py-2.5 text-sm font-medium text-stone-700"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
            <a
              href="/#quickstart"
              onClick={() => setOpen(false)}
              className="mt-1 inline-flex items-center justify-center rounded-xl bg-flame-500 px-3 py-2.5 text-sm font-semibold text-white shadow-card"
            >
              Install Genosyn
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
