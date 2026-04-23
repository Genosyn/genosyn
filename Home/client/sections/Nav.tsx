import { Github } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const LINKS = [
  { href: "#primitives", label: "Primitives" },
  { href: "#day-in-the-life", label: "A day" },
  { href: "#platform", label: "Platform" },
  { href: "#quickstart", label: "Quickstart" },
  { href: "#cli", label: "CLI" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/75 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <a href="/" className="flex items-center text-slate-900" aria-label="Genosyn">
          <Logo className="h-7 w-auto" />
        </a>

        <nav className="hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
          >
            <Github className="h-4 w-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <a
            href="#quickstart"
            className="hidden items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 sm:inline-flex"
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}
