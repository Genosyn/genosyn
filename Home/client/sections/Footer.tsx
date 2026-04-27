import { ArrowRight, Github, Terminal } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const ISSUES_URL = `${GITHUB_URL}/issues`;

export function Footer() {
  return (
    <footer className="relative bg-white">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 px-8 py-14 text-center sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.18),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
          />

          <div className="relative">
            <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] text-white sm:text-5xl">
              Meet your first AI employee.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-zinc-300">
              One command pulls the image and starts Genosyn on{" "}
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[12px] text-white">
                localhost:8471
              </code>
              . Write their soul. Schedule their first routine.
            </p>

            <div className="mx-auto mt-8 flex max-w-xl items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left font-mono text-[13px] text-zinc-200 shadow-card">
              <Terminal className="h-4 w-4 text-zinc-300" />
              <span className="text-zinc-500">$</span>
              <span className="truncate">curl -fsSL genosyn.com/install.sh | bash</span>
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-950 shadow-lift transition hover:bg-zinc-100 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                Star on GitHub
              </a>
              <a
                href="#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/5 sm:w-auto"
              >
                See quickstart
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-6 border-t border-zinc-100 pt-8 text-xs text-zinc-500 sm:flex-row">
          <div className="flex items-center gap-3 text-zinc-700">
            <Logo className="h-5 w-auto" />
            <span>© {new Date().getFullYear()} HackerBay, Inc. · Built in the open.</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-zinc-900">
              GitHub
            </a>
            <a href={ROADMAP_URL} target="_blank" rel="noreferrer" className="hover:text-zinc-900">
              Roadmap
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-zinc-900">
              Issues
            </a>
            <a href="/install.sh" className="hover:text-zinc-900">
              install.sh
            </a>
            <span className="font-mono text-zinc-400">v0.2.0</span>
          </nav>
        </div>
        <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-400 sm:text-left">
          Disclaimer: this software is AI generated. Use at your own risk. Open source and provided without warranty of any kind.
        </p>
      </div>
    </footer>
  );
}
