import { Github } from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";
import { Logo } from "@/components/Logo";

const ISSUES_URL = `${GITHUB_URL}/issues`;

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 px-8 py-12 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Meet your first AI employee.
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-sm text-slate-600">
            Clone the repo, run one command, and write their Soul.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 sm:w-auto"
            >
              <Github className="h-4 w-4" />
              View on GitHub
            </a>
            <a
              href="#quickstart"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:text-slate-900 sm:w-auto"
            >
              See quickstart
            </a>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-6 border-t border-slate-200 pt-8 text-xs text-slate-500 sm:flex-row">
          <div className="flex items-center gap-3 text-slate-600">
            <Logo className="h-5 w-auto" />
            <span>&copy; {new Date().getFullYear()} Built in the open.</span>
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
