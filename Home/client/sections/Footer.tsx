import { Github } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Open source. Self-hostable. MIT.
        </h2>
        <p className="mt-3 text-sm text-slate-600">
          Clone the repo, run a single command, and meet your first AI employee.
        </p>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          <Github className="h-4 w-4" />
          View on GitHub
        </a>
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-slate-200 pt-8 text-xs text-slate-500 sm:flex-row">
          <span>&copy; {new Date().getFullYear()} Genosyn. Built in the open.</span>
          <span className="font-mono">v0.0.1</span>
        </div>
      </div>
    </footer>
  );
}
