import { GITHUB_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const LINKS = [
  { href: "#primitives", label: "primitives" },
  { href: "#day", label: "tuesday" },
  { href: "#platform", label: "platform" },
  { href: "#quickstart", label: "install" },
  { href: "#cli", label: "cli" },
  { href: "#house-rules", label: "rules" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink bg-bone-page">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-6 px-6">
        <a href="/" className="flex items-center text-ink" aria-label="Genosyn">
          <Logo className="h-6 w-auto" />
        </a>

        <nav className="hidden items-center gap-7 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="hover:text-accent">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em]">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hidden text-ink-soft hover:text-accent sm:inline"
          >
            github
          </a>
          <a
            href="#quickstart"
            className="inline-flex items-center gap-2 border border-ink bg-ink px-3 py-1.5 text-[10px] text-bone-page hover:bg-accent hover:border-accent"
          >
            install
            <span aria-hidden>↘</span>
          </a>
        </div>
      </div>
    </header>
  );
}
