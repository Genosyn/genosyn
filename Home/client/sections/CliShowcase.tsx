import { useState } from "react";
import { Check, Copy, Database, Github, Server, ShieldCheck, Terminal } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { SectionEyebrow } from "@/sections/Primitives";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

const FACTS = [
  {
    icon: Server,
    title: "Runs where you choose",
    body: "Start on one Linux host with Docker. Move to Postgres when the company outgrows it.",
  },
  {
    icon: Database,
    title: "Your data stays yours",
    body: "Company records, Souls, Skills, Routines, Run logs, and encrypted credentials stay under your control.",
  },
  {
    icon: ShieldCheck,
    title: "Autonomy needs uptime",
    body: "The Genosyn CLI handles upgrades, health checks, backups, logs, and recovery — so the Routines keep firing.",
  },
];

export function CliShowcase() {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The command remains selectable when clipboard permission is unavailable.
    }
  }

  return (
    <section id="quickstart" className="border-y border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:gap-16">
          <div>
            <SectionEyebrow>Self-hosted from day one</SectionEyebrow>
            <h2 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
              Your company. Your infrastructure. Your keys.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
              A company that runs itself should not run on someone else&apos;s computer. Genosyn
              installs as a single self-hosted application — bring Anthropic, OpenAI, or a custom
              OpenAI-compatible endpoint, and keep the operating data on infrastructure you control.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <a
                href="/docs/install"
                className="inline-flex items-center justify-center rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                Read the install guide
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400"
              >
                <Github className="h-4 w-4" />
                View the source
              </a>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-[0_24px_60px_-28px_rgba(15,23,42,0.65)]">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="ml-2 flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
                <Terminal className="h-3.5 w-3.5" />
                Install Genosyn
              </span>
              <button
                type="button"
                onClick={copyCommand}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                aria-label="Copy install command"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="px-5 py-6 font-mono text-xs leading-7 sm:px-6 sm:text-[13px]">
              <div>
                <span className="text-slate-600">$ </span>
                <span className="text-slate-100">curl -fsSL </span>
                <span className="text-slate-300">https://genosyn.com/install.sh</span>
                <span className="text-slate-100"> | bash</span>
              </div>
              <div className="mt-4 text-slate-500">→ Pulling the latest Genosyn release</div>
              <div className="text-slate-500">→ Creating the persistent data volume</div>
              <div className="text-slate-500">→ Starting Genosyn on port 8471</div>
              <div className="mt-4 text-emerald-400">✓ Genosyn is ready</div>
              <div className="mt-1 text-slate-500">
                Open <span className="text-slate-300">http://localhost:8471</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-12 grid gap-3 md:grid-cols-3">
          {FACTS.map((fact) => (
            <article key={fact.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <fact.icon className="h-5 w-5 text-slate-950" />
              <h3 className="mt-4 text-sm font-semibold text-slate-900">{fact.title}</h3>
              <p className="mt-2 text-xs leading-5 text-slate-500">{fact.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
