import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo, LogoMark } from "@/components/Logo";
import { Link, usePathname } from "@/lib/router";

const LINKS = [
  { href: "/roles", label: "Roles" },
  { href: "/products", label: "Products" },
  { href: "/#autonomy", label: "Autonomy" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
];

/** A compact, product-like application header with an accessible mobile menu. */
export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const path = usePathname();

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 12);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 border-b border-slate-200 bg-white transition-shadow duration-300 ${scrolled ? "shadow-sm" : ""}`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-5 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="shrink-0 text-slate-900 transition-opacity duration-150 hover:opacity-75"
          aria-label="Genosyn home"
        >
          <LogoMark className="h-7 w-7 sm:hidden" />
          <Logo className="hidden text-[15px] sm:block" />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary navigation">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={path === link.href ? "page" : undefined}
              className={`rounded-lg px-2.5 py-2 text-sm font-medium transition-colors duration-150 ${path === link.href ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span className="tabular whitespace-nowrap text-[11px] text-slate-500">
            {`v${__APP_VERSION__}`}
          </span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-md px-2.5 py-2 text-sm font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-900 sm:inline-flex"
          >
            GitHub
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>
          <a
            href="/#install"
            className="motion-button hidden min-h-10 items-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-indigo-700 sm:inline-flex"
          >
            Install
          </a>
          <button
            ref={toggle}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label="Toggle navigation"
            aria-controls="site-navigation"
            aria-expanded={open}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors duration-150 hover:bg-slate-50 lg:hidden"
          >
            {open ? (
              <X aria-hidden className="h-4 w-4" />
            ) : (
              <Menu aria-hidden className="h-4 w-4" />
            )}
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      <div className="site-menu grid lg:hidden" data-open={open}>
        <div className="site-menu-clip">
          <nav
            id="site-navigation"
            className="border-t border-slate-200 bg-white px-4 py-2 shadow-sm sm:px-6"
            aria-label="Mobile navigation"
            aria-hidden={!open}
            {...(open ? {} : { inert: "" })}
          >
            <div className="mx-auto grid max-w-7xl gap-1">
              {LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  aria-current={path === link.href ? "page" : undefined}
                  className="rounded-md px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-900"
                >
                  {link.label}
                </Link>
              ))}
              <div className="mt-1 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 sm:hidden">
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition-colors duration-150 hover:bg-slate-50"
                >
                  GitHub
                  <span className="sr-only">{"(opens in a new tab)"}</span>
                </a>
                <a
                  href="/#install"
                  onClick={() => setOpen(false)}
                  className="inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-indigo-700"
                >
                  Install
                </a>
              </div>
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}
