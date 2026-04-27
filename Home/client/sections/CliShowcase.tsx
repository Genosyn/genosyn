import { useState } from "react";
import {
  ArchiveRestore,
  ArrowUpRight,
  Download,
  RefreshCw,
  ScrollText,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type CommandRow = {
  command: string;
  arg?: string;
  description: string;
};

const COMMANDS: CommandRow[] = [
  { command: "install", description: "Pull the image and start the container." },
  { command: "upgrade", description: "Pull the latest image and recreate. Volume preserved." },
  { command: "status", description: "Show state, image digest, volume, and URL." },
  { command: "logs", arg: "-f", description: "Tail the server log from the running container." },
  { command: "backup", arg: "--out FILE", description: "Tarball the data volume for safekeeping." },
  { command: "restore", arg: "FILE", description: "Roll the volume back to a previous snapshot." },
  { command: "uninstall", arg: "--purge", description: "Stop and remove. --purge wipes the volume too." },
];

type Workflow = {
  icon: LucideIcon;
  tag: string;
  title: string;
  body: string;
  code: string;
};

const WORKFLOWS: Workflow[] = [
  {
    icon: RefreshCw,
    tag: "Upgrade",
    title: "Zero-drama upgrades",
    body: "Pulls the newest image and swaps the container. Your volume is never touched. Roll back any time.",
    code: "$ genosyn upgrade",
  },
  {
    icon: Download,
    tag: "Back up",
    title: "A tarball you can trust",
    body: "Snapshots the database and every employee's credentials into one .tar.gz. Cron it. Sync to S3.",
    code: "$ genosyn backup --out backup.tar.gz",
  },
  {
    icon: ArchiveRestore,
    tag: "Restore",
    title: "Walk back any incident",
    body: "Stop, restore, start. The CLI prompts before overwriting so a typo never costs you production.",
    code: "$ genosyn restore backup.tar.gz",
  },
];

type TabKey = "help" | "status";

export function CliShowcase() {
  const [tab, setTab] = useState<TabKey>("help");

  return (
    <section id="cli" className="border-t border-zinc-100 bg-gradient-to-b from-white to-zinc-50/60">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>The CLI</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            Your cluster, at your command.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            One binary handles install, upgrade, status, logs, and disaster
            recovery. No Docker flags to memorize.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-5xl overflow-hidden rounded-2xl border border-zinc-900 bg-zinc-950 shadow-lift">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
            <div className="ml-3 flex items-center gap-1 rounded-lg bg-white/5 p-0.5 text-xs">
              <TabButton active={tab === "help"} onClick={() => setTab("help")} icon={ScrollText} label="genosyn help" />
              <TabButton active={tab === "status"} onClick={() => setTab("status")} icon={Terminal} label="genosyn status" />
            </div>
            <a
              href="https://github.com/Genosyn/genosyn/blob/main/CLI/genosyn"
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
            >
              Source
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
          {tab === "help" ? <HelpPane /> : <StatusPane />}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-5 md:grid-cols-3">
          {WORKFLOWS.map((w) => (
            <article
              key={w.tag}
              className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200">
                  <w.icon className="h-4 w-4" />
                </div>
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {w.tag}
                </span>
              </div>
              <h3 className="mt-4 text-base font-semibold text-zinc-950">{w.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{w.body}</p>
              <pre className="mt-auto pt-4 font-mono text-[12px] leading-5">
                <code className="block overflow-x-auto rounded-lg bg-zinc-950 px-3 py-2 text-zinc-200">
                  {w.code}
                </code>
              </pre>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition ${
        active
          ? "bg-white/10 text-white shadow-sm"
          : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function HelpPane() {
  return (
    <div className="px-6 py-6 font-mono text-[13px] leading-7 text-zinc-300">
      <div className="text-zinc-500">
        <span className="text-zinc-100">genosyn</span> — cluster maintainer for self-hosted Genosyn.
      </div>
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
        Commands
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-10 gap-y-1.5 md:grid-cols-2">
        {COMMANDS.map((row) => (
          <div
            key={row.command}
            className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-3"
          >
            <div className="truncate">
              <span className="text-emerald-300">{row.command}</span>
              {row.arg && <span className="ml-1.5 text-zinc-500">{row.arg}</span>}
            </div>
            <div className="truncate text-zinc-400">{row.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPane() {
  return (
    <pre className="overflow-x-auto px-6 py-6 font-mono text-[13px] leading-7 text-zinc-200">
      <code>
        <span className="text-zinc-500">$ </span>
        <span className="text-zinc-100">genosyn status</span>
        {"\n\n"}
        <span className="text-zinc-500">Container  </span>
        <span className="text-zinc-100">genosyn</span>
        {"\n"}
        <span className="text-zinc-500">State      </span>
        <span className="text-emerald-400">running</span>
        {"\n"}
        <span className="text-zinc-500">Image      </span>
        <span className="text-emerald-300">ghcr.io/genosyn/app:latest</span>
        {"\n"}
        <span className="text-zinc-500">Digest     </span>
        <span className="text-zinc-400">sha256:a1f3…b20e</span>
        {"\n"}
        <span className="text-zinc-500">Volume     </span>
        <span className="text-zinc-300">genosyn-data (412 MB)</span>
        {"\n"}
        <span className="text-zinc-500">Port       </span>
        <span className="text-zinc-300">8471 → 8471</span>
        {"\n"}
        <span className="text-zinc-500">Uptime     </span>
        <span className="text-zinc-300">17d 4h 22m</span>
        {"\n\n"}
        <span className="text-zinc-500">Open  </span>
        <span className="text-emerald-300">http://localhost:8471</span>
      </code>
    </pre>
  );
}
