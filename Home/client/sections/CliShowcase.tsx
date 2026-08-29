import { useState } from "react";
import { BookOpen, Check, Copy, Database, Github, Server, ShieldCheck, Terminal } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { Button, Container, Eyebrow, Heading, Lede, Panel, Section } from "@/sections/Kit";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

const FACTS = [
  {
    icon: Server,
    title: "Runs where you choose",
    body: "Start on one Linux host with Docker. Move to Postgres when the company outgrows it.",
    tile: "bg-sky-100 text-sky-700 ring-sky-200",
  },
  {
    icon: Database,
    title: "Your data stays yours",
    body: "Company records, Souls, Skills, Routines, Run logs, and encrypted credentials stay under your control.",
    tile: "bg-violet-100 text-violet-700 ring-violet-200",
  },
  {
    icon: ShieldCheck,
    title: "Autonomy needs uptime",
    body: "The Genosyn CLI handles upgrades, health checks, backups, logs, and recovery — so the Routines keep firing.",
    tile: "bg-emerald-100 text-emerald-700 ring-emerald-200",
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
    <Section id="quickstart" tone="tint">
      <Container wide>
        <div className="grid gap-12 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:gap-16">
          <div>
            <Eyebrow>Self-hosted from day one</Eyebrow>
            <Heading className="mt-6">Your company. Your infrastructure. Your keys.</Heading>
            <Lede className="mt-6 max-w-xl">
              A company that runs itself should not run on someone else&apos;s computer. Genosyn
              installs as a single self-hosted application — bring Anthropic, OpenAI, or a custom
              OpenAI-compatible endpoint, and keep the operating data on infrastructure you control.
            </Lede>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button href="/docs/install">
                <BookOpen aria-hidden className="h-4 w-4" />
                Read the install guide
              </Button>
              <Button href={GITHUB_URL} external variant="secondary">
                <Github aria-hidden className="h-4 w-4" />
                View the source
              </Button>
            </div>
          </div>

          <div className="on-night overflow-hidden rounded-2xl border border-night-700 bg-night-950 shadow-float">
            <div className="flex items-center gap-2 border-b border-white/[0.10] px-4 py-3">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              <span className="ml-2 flex items-center gap-1.5 text-[11px] font-semibold text-violet-100/60">
                <Terminal aria-hidden className="h-3.5 w-3.5" />
                Install Genosyn
              </span>
              <button
                type="button"
                onClick={copyCommand}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/[0.14] bg-white/[0.06] px-2.5 py-1 font-mono text-[10px] font-semibold text-violet-100/80 transition hover:bg-white/[0.12] hover:text-white"
                aria-label="Copy install command"
              >
                {copied ? (
                  <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy aria-hidden className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="px-5 py-6 font-mono text-xs leading-7 sm:px-7 sm:text-[13px]">
              <div>
                <span className="text-tide-400">$ </span>
                <span className="text-white">curl -fsSL </span>
                <span className="text-sky-300">https://genosyn.com/install.sh</span>
                <span className="text-white"> | bash</span>
              </div>
              <div className="mt-4 text-violet-100/60">
                <span className="text-violet-300">→</span> Pulling the latest Genosyn release
              </div>
              <div className="text-violet-100/60">
                <span className="text-violet-300">→</span> Creating the persistent data volume
              </div>
              <div className="text-violet-100/60">
                <span className="text-violet-300">→</span> Starting Genosyn on port 8471
              </div>
              <div className="mt-4 font-semibold text-emerald-400">✓ Genosyn is ready</div>
              <div className="mt-1 text-violet-100/60">
                Open <span className="text-sky-300">http://localhost:8471</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {FACTS.map((fact) => (
            <Panel key={fact.title} hover className="p-6">
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ring-inset ${fact.tile}`}
              >
                <fact.icon aria-hidden className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-base font-semibold text-stone-900">{fact.title}</h3>
              <p className="mt-2 text-[13px] leading-6 text-stone-600">{fact.body}</p>
            </Panel>
          ))}
        </div>
      </Container>
    </Section>
  );
}
