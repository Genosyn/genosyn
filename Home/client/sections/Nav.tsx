import { useEffect, useRef, useState } from "react";
import { ArrowRight, Github, Menu, X } from "lucide-react";
import { GITHUB_URL, INSTALL_DOCS_PATH } from "@/lib/constants";
import { Logo } from "@/components/Logo";
import { Link, usePathname } from "@/lib/router";

const LINKS = [
  { href: "/vision", label: "Vision" },
  { href: "/blog", label: "Blog" },
  { href: "/roles", label: "Roles" },
  { href: "/products", label: "Products" },
  { href: "/docs", label: "Docs" },
];

function isActive(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/** The site header: quiet on paper, and a full-height menu below `lg`. */
export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const path = usePathname();

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const solid = scrolled || open;

  return (
    <header
      className={`sticky top-0 z-50 transition-[background-color,border-color] duration-300 ${
        solid ? "border-b border-line bg-paper" : "border-b border-transparent bg-paper"
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-site items-center gap-6 px-5 sm:h-[4.5rem] sm:px-8 lg:px-10">
        <Link
          href="/"
          className="shrink-0 text-ink transition-opacity duration-150 hover:opacity-70"
          aria-label="Genosyn home"
        >
          <Logo className="text-[14px] sm:text-[15px]" />
        </Link>

        <nav className="ml-4 hidden items-center gap-1 lg:flex" aria-label="Primary">
          {LINKS.map((link) => {
            const active = isActive(path, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`relative rounded-full px-3.5 py-2 text-[14.5px] transition-colors duration-150 ${
                  active ? "text-ink" : "text-ink-500 hover:text-ink"
                }`}
              >
                {link.label}
                {active && (
                  <span aria-hidden className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-ink" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden h-10 items-center gap-2 rounded-full px-3 text-[14.5px] text-ink-500 transition-colors hover:text-ink md:inline-flex"
          >
            <Github aria-hidden className="h-4 w-4" />
            GitHub
            <span className="sr-only">{"(opens in a new tab)"}</span>
          </a>
          <Link
            href={INSTALL_DOCS_PATH}
            className="press group ml-1 hidden h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.2)] hover:bg-ink-800 sm:inline-flex"
          >
            Install Genosyn
            <ArrowRight aria-hidden className="nudge h-3.5 w-3.5" />
          </Link>
          <button
            ref={toggle}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-controls="site-menu"
            aria-expanded={open}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line-strong text-ink transition-colors hover:bg-paper-raised lg:hidden"
          >
            {open ? <X aria-hidden className="h-4 w-4" /> : <Menu aria-hidden className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div
        id="site-menu"
        className="site-menu fixed inset-x-0 bottom-0 top-16 overflow-y-auto bg-paper sm:top-[4.5rem] lg:hidden"
        data-open={open}
        aria-hidden={!open}
        {...(open ? {} : { inert: "" })}
      >
        <nav aria-label="Mobile" className="mx-auto flex min-h-full max-w-site flex-col px-5 pb-10 pt-4 sm:px-8">
          <ul className="border-t border-line">
            {[{ href: "/", label: "Home" }, ...LINKS].map((link) => (
              <li key={link.href} className="border-b border-line">
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  aria-current={path === link.href ? "page" : undefined}
                  className="group flex items-center justify-between py-4 font-display text-[1.6rem] leading-none tracking-[-0.035em] text-ink"
                >
                  {link.label}
                  <ArrowRight aria-hidden className="nudge h-5 w-5 text-ink-400" />
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-auto grid gap-2 pt-10 sm:grid-cols-2">
            <Link
              href={INSTALL_DOCS_PATH}
              onClick={() => setOpen(false)}
              className="inline-flex h-12 items-center justify-center rounded-full bg-ink text-[15px] font-medium text-white"
            >
              Install on your hardware
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line-strong text-[15px] font-medium text-ink"
            >
              <Github aria-hidden className="h-4 w-4" />
              GitHub
              <span className="sr-only">{"(opens in a new tab)"}</span>
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}
