import { useState, type ReactNode } from "react";
import { ArrowRight, Github } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Link } from "@/lib/router";
import { Claims } from "@/sections/Claims";
import { DEPT_FULL, type Dept } from "@/sections/Kit";
import { Wall } from "@/sections/Wall";

const DEPARTMENTS: { dept: Dept; label: string }[] = [
  { dept: "email", label: "Email" },
  { dept: "finance", label: "Finance" },
  { dept: "repositories", label: "Repositories" },
  { dept: "revenue", label: "Revenue" },
  { dept: "workspace", label: "Workspace" },
  { dept: "marketing", label: "Marketing" },
  { dept: "operations", label: "Operations" },
];

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

export function Hero() {
  return (
    <section className="overflow-hidden bg-slate-50">
      <div className="mx-auto w-full max-w-7xl px-4 pb-10 pt-14 sm:px-6 sm:pb-14 sm:pt-20 lg:px-8 lg:pt-24">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(21rem,0.85fr)] lg:gap-16">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-indigo-700">
                Open source · Self-hosted · Apache 2.0
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-500">
                {`v${__APP_VERSION__}`}
              </span>
            </div>

            <h1 className="mt-6 max-w-[13ch] text-balance text-[clamp(2.75rem,6vw,5rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-slate-950">
              Your company can now run automatically.
            </h1>

            <p className="mt-6 max-w-[40rem] text-lg leading-8 text-slate-600">
              Genosyn is an open-source platform for running a company with AI Employees. They hold
              real roles and work to their own schedule.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <HeroLink href="/roles/sdr" primary>
                One role, hour by hour
                <ArrowRight aria-hidden className="h-4 w-4" />
              </HeroLink>
              <HeroLink href={GITHUB_URL} external>
                <Github aria-hidden className="h-4 w-4" />
                Apache 2.0 on GitHub
              </HeroLink>
            </div>
          </div>

          <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Start on your infrastructure</p>
                <p className="mt-1 text-sm text-slate-500">One command. Your data stays yours.</p>
              </div>
              <span className="hidden rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline">
                Ready
              </span>
            </div>

            <InstallStrip />
            <Claims className="mt-5 border-t border-slate-100 pt-5" />

            <dl className="mt-5 border-t border-slate-100 pt-5">
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                Seven departments, one you
              </dt>
              <dd className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {DEPARTMENTS.map(({ dept, label }) => (
                  <span key={label} className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${DEPT_FULL[dept]}`}
                    />
                    <span className="truncate text-sm text-slate-600">{label}</span>
                  </span>
                ))}
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-indigo-600" />
                  <span className="truncate text-sm font-medium text-slate-900">
                    Needs a person
                  </span>
                </span>
              </dd>
            </dl>
          </div>
        </div>

        <div className="mt-12 sm:mt-16">
          <Wall />
        </div>
      </div>
    </section>
  );
}

function InstallStrip() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command stays selectable when clipboard permission is unavailable.
    }
  }

  return (
    <div className="mt-4 flex min-h-12 min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-slate-950 px-3 shadow-inner">
      <span aria-hidden className="select-none font-mono text-xs text-indigo-300">
        $
      </span>
      <code className="scrollbar-none min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-slate-100">
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-slate-300 transition-colors duration-100 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        {copied ? "Copied" : "Copy"}
        <span className="sr-only"> install command</span>
      </button>
    </div>
  );
}

function HeroLink({
  href,
  external,
  primary = false,
  children,
}: {
  href: string;
  external?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  const className = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
    primary
      ? "border-indigo-600 bg-indigo-600 text-white hover:border-indigo-700 hover:bg-indigo-700"
      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950"
  }`;

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
