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

type CommandRow = {
  command: string;
  arg?: string;
  description: string;
};

const COMMANDS: CommandRow[] = [
  { command: "install", description: "Pull the image and start the container." },
  { command: "upgrade", description: "Pull the latest image and recreate — volume preserved." },
  { command: "status", description: "Show state, image digest, volume, and URL." },
  { command: "logs", arg: "-f", description: "Tail the server log from the running container." },
  { command: "backup", arg: "--out FILE", description: "Tarball the data volume for safekeeping." },
  { command: "restore", arg: "FILE", description: "Roll the volume back to a previous snapshot." },
  { command: "uninstall", arg: "--purge", description: "Stop and remove; --purge wipes the volume too." },
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
    title: "Zero-drama upgrades.",
    body: "Pulls the newest image and swaps the container. Your volume is never touched — roll back by pointing --image at the previous tag.",
    code: "$ genosyn upgrade",
  },
  {
    icon: Download,
    tag: "Back up",
    title: "A tarball you can trust.",
    body: "Snapshot the database and every employee's credentials into one .tar.gz. Cron it, sync to S3, keep 30 days. It's just a file.",
    code: "$ genosyn backup --out /b/genosyn-$(date +%F).tar.gz",
  },
  {
    icon: ArchiveRestore,
    tag: "Restore",
    title: "Walk back any incident.",
    body: "Stop, restore, start. The CLI prompts before overwriting so a typo never costs you production — pass --yes only when scripting.",
    code: "$ genosyn restore ~/backups/genosyn-2026-04-22.tar.gz",
  },
];

type TabKey = "help" | "status";

export function CliShowcase() {
  const [tab, setTab] = useState<TabKey>("help");

  return (
    <section id="cli" className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          <Terminal className="h-3.5 w-3.5 text-indigo-500" />
          genosyn CLI
        </div>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Your cluster, at your command.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          One binary handles install, upgrade, status, logs, and disaster
          recovery. No Docker flags to memorise.
        </p>
      </div>

      <div className="mt-12 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl shadow-slate-900/10">
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          <div className="ml-3 flex items-center gap-1 rounded-lg bg-slate-900 p-0.5 text-xs font-medium">
            <TabButton active={tab === "help"} onClick={() => setTab("help")} icon={ScrollText} label="genosyn help" />
            <TabButton active={tab === "status"} onClick={() => setTab("status")} icon={Terminal} label="genosyn status" />
          </div>
          <a
            href="https://github.com/Genosyn/genosyn/blob/main/CLI/genosyn"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
          >
            Source
            <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>
        {tab === "help" ? <HelpPane /> : <StatusPane />}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {WORKFLOWS.map((w) => (
          <WorkflowCard key={w.tag} workflow={w} />
        ))}
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
          ? "bg-slate-800 text-slate-100 shadow-sm"
          : "text-slate-400 hover:text-slate-200"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function HelpPane() {
  return (
    <div className="px-6 py-5 font-mono text-[13px] leading-6 text-slate-300">
      <div className="text-slate-500">
        <span className="text-slate-100">genosyn</span> — cluster maintainer for self-hosted Genosyn.
      </div>
      <div className="mt-4 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
        Commands
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 md:grid-cols-2">
        {COMMANDS.map((row) => (
          <div
            key={row.command}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3"
          >
            <div className="truncate">
              <span className="text-indigo-300">{row.command}</span>
              {row.arg && <span className="ml-1.5 text-slate-500">{row.arg}</span>}
            </div>
            <div className="truncate text-slate-400">{row.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusPane() {
  return (
    <pre className="overflow-x-auto px-6 py-5 font-mono text-[13px] leading-6 text-slate-200">
      <code>
        <span className="text-slate-500">$ </span>
        <span className="text-slate-100">genosyn status</span>
        {"\n\n"}
        <span className="text-slate-500">Container</span>
        {"  "}
        <span className="text-slate-100">genosyn</span>
        {"\n"}
        <span className="text-slate-500">State</span>
        {"      "}
        <span className="text-emerald-400">running</span>
        {"\n"}
        <span className="text-slate-500">Image</span>
        {"      "}
        <span className="text-indigo-300">ghcr.io/genosyn/app:latest</span>
        {"\n"}
        <span className="text-slate-500">Digest</span>
        {"     "}
        <span className="text-slate-400">sha256:a1f3…b20e</span>
        {"\n"}
        <span className="text-slate-500">Volume</span>
        {"     "}
        <span className="text-slate-300">genosyn-data (412 MB)</span>
        {"\n"}
        <span className="text-slate-500">Port</span>
        {"       "}
        <span className="text-slate-300">8471 → 8471</span>
        {"\n"}
        <span className="text-slate-500">Uptime</span>
        {"     "}
        <span className="text-slate-300">17d 4h</span>
        {"\n\n"}
        <span className="text-slate-500">Open  </span>
        <span className="text-indigo-300">http://localhost:8471</span>
      </code>
    </pre>
  );
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const Icon = workflow.icon;
  return (
    <div className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-widest text-indigo-600">
          {workflow.tag}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{workflow.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{workflow.body}</p>
      <div className="mt-auto pt-4">
        <div className="overflow-x-auto rounded-lg bg-slate-950 px-3 py-2 font-mono text-[12px] leading-5 text-slate-200">
          {workflow.code}
        </div>
      </div>
    </div>
  );
}
