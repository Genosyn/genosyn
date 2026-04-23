import { ArrowUpRight, Github, Terminal } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const ISSUES_URL = `${GITHUB_URL}/issues`;

export function Footer() {
  return (
    <footer className="relative border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-slate-950 px-8 py-14 text-center sm:px-12 sm:py-16">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_top,theme(colors.indigo.500/45%),transparent_60%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,theme(colors.white/6%)_1px,transparent_1px),linear-gradient(to_bottom,theme(colors.white/6%)_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_80%)]"
          />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Meet your first AI employee.
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-slate-300">
              One command pulls the image and starts Genosyn on{" "}
              <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[12px] text-slate-100">
                localhost:8471
              </code>
              . Write their Soul. Schedule their first routine.
            </p>
            <div className="mx-auto mt-8 inline-flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-2 py-2 font-mono text-[13px] text-slate-200">
              <Terminal className="h-4 w-4 text-indigo-300" />
              <span className="text-slate-400">$</span>
              <span>curl -fsSL genosyn.com/install.sh | bash</span>
            </div>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-100 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
              <a
                href="#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/5 sm:w-auto"
              >
                See quickstart
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-6 border-t border-slate-200 pt-8 text-xs text-slate-500 sm:flex-row">
          <div className="flex items-center gap-3 text-slate-600">
            <Logo className="h-5 w-auto" />
            <span>&copy; {new Date().getFullYear()} HackerBay, Inc. · Built in the open.</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-slate-900">
              GitHub
            </a>
            <a href={ROADMAP_URL} target="_blank" rel="noreferrer" className="hover:text-slate-900">
              Roadmap
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-slate-900">
              Issues
            </a>
            <span className="font-mono">v0.0.1</span>
          </nav>
        </div>
      </div>
    </footer>
  );
}
