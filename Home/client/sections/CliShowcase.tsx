import { useState } from "react";
import { ArrowUpRight } from "lucide-react";

type CommandRow = {
  command: string;
  arg?: string;
  description: string;
};

const COMMANDS: CommandRow[] = [
  { command: "install", description: "pull the image and start the container." },
  { command: "upgrade", description: "pull the latest image and recreate. volume preserved." },
  { command: "status", description: "show state, image digest, volume, and url." },
  { command: "logs", arg: "-f", description: "tail the server log from the running container." },
  { command: "backup", arg: "--out FILE", description: "tarball the data volume for safekeeping." },
  { command: "restore", arg: "FILE", description: "roll the volume back to a previous snapshot." },
  { command: "uninstall", arg: "--purge", description: "stop and remove. --purge wipes the volume." },
];

type Workflow = {
  step: string;
  tag: string;
  title: string;
  body: string;
  code: string;
};

const WORKFLOWS: Workflow[] = [
  {
    step: "i",
    tag: "upgrade",
    title: "Zero-drama upgrades.",
    body: "Pulls the newest image and swaps the container. Your volume is never touched. Roll back with --image=previous-tag when you need to.",
    code: "$ genosyn upgrade",
  },
  {
    step: "ii",
    tag: "back up",
    title: "A tarball you can trust.",
    body: "Snapshots the database and every employee's credentials into a single .tar.gz. Cron it. Sync to S3. Keep thirty days. It is just a file.",
    code: "$ genosyn backup --out /b/g-$(date +%F).tar.gz",
  },
  {
    step: "iii",
    tag: "restore",
    title: "Walk back any incident.",
    body: "Stop, restore, start. The CLI prompts before overwriting so a typo never costs you production. Pass --yes only when you mean it.",
    code: "$ genosyn restore ~/backups/g-2026-04-22.tar.gz",
  },
];

type TabKey = "help" | "status";

export function CliShowcase() {
  const [tab, setTab] = useState<TabKey>("help");

  return (
    <section id="cli" className="border-b border-ink bg-bone-page">
      <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-20 sm:pb-24">
        <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <span className="text-ink">§ 05</span>
            <span className="text-ink-mute">/</span>
            <span>the cli</span>
          </div>
          <div>
            <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
              Your cluster,
              <br />
              <span className="serif-italic text-accent">at your command.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">
              One bash binary handles install, upgrade, status, logs, and disaster
              recovery. Reads as plain shell — no Docker flags to memorise.
            </p>
          </div>
        </div>

        <div className="mt-12 border border-ink bg-ink">
          <div className="flex flex-wrap items-center gap-2 border-b border-bone-card/15 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.22em] text-bone-card/55">
            <button
              type="button"
              onClick={() => setTab("help")}
              className={`px-3 py-1 transition ${
                tab === "help"
                  ? "border border-bone-card/30 text-bone-card"
                  : "text-bone-card/55 hover:text-bone-card"
              }`}
            >
              genosyn help
            </button>
            <button
              type="button"
              onClick={() => setTab("status")}
              className={`px-3 py-1 transition ${
                tab === "status"
                  ? "border border-bone-card/30 text-bone-card"
                  : "text-bone-card/55 hover:text-bone-card"
              }`}
            >
              genosyn status
            </button>
            <a
              href="https://github.com/Genosyn/genosyn/blob/main/CLI/genosyn"
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 text-bone-card/55 hover:text-amber-200"
            >
              read source
              <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
          {tab === "help" ? <HelpPane /> : <StatusPane />}
        </div>

        <div className="mt-14 grid grid-cols-1 gap-0 border-t border-ink md:grid-cols-3">
          {WORKFLOWS.map((w, i) => (
            <article
              key={w.tag}
              className={`flex flex-col gap-5 border-b border-ink px-6 py-10 md:border-b-0 ${
                i < WORKFLOWS.length - 1 ? "md:border-r md:border-ink" : ""
              }`}
            >
              <div className="flex items-baseline gap-3 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
                <span className="serif-italic text-3xl leading-none text-accent">
                  {w.step}.
                </span>
                <span className="text-ink">{w.tag}</span>
              </div>
              <h3 className="font-serif text-2xl leading-[1.1] text-ink">
                {w.title}
              </h3>
              <p className="text-base leading-[1.6] text-ink-soft">{w.body}</p>
              <pre className="mt-auto overflow-x-auto border border-ink bg-ink px-4 py-3 font-mono text-[12.5px] leading-[1.6] text-bone-card">
                <code>{w.code}</code>
              </pre>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HelpPane() {
  return (
    <div className="px-6 py-6 font-mono text-[13px] leading-[1.7] text-bone-card/85">
      <div>
        <span className="text-bone-card">genosyn</span>{" "}
        <span className="text-bone-card/55">— cluster maintainer for self-hosted Genosyn.</span>
      </div>
      <div className="mt-5 text-[10px] font-medium uppercase tracking-[0.22em] text-bone-card/45">
        commands
      </div>
      <div className="mt-3 grid grid-cols-1 gap-x-10 gap-y-1.5 md:grid-cols-2">
        {COMMANDS.map((row) => (
          <div
            key={row.command}
            className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-3"
          >
            <div className="truncate">
              <span className="text-amber-200">{row.command}</span>
              {row.arg && (
                <span className="ml-1.5 text-bone-card/45">{row.arg}</span>
              )}
            </div>
            <div className="truncate text-bone-card/65">{row.description}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 text-[10px] font-medium uppercase tracking-[0.22em] text-bone-card/45">
        $ genosyn help &lt;command&gt; for details
      </div>
    </div>
  );
}

function StatusPane() {
  return (
    <pre className="overflow-x-auto px-6 py-6 font-mono text-[13px] leading-[1.7] text-bone-card">
      <code>
        <span className="text-bone-card/45">$ </span>
        <span className="text-bone-card">genosyn status</span>
        {"\n\n"}
        <span className="text-bone-card/45">container  </span>
        <span className="text-bone-card">genosyn</span>
        {"\n"}
        <span className="text-bone-card/45">state      </span>
        <span className="text-emerald-300">running</span>
        {"\n"}
        <span className="text-bone-card/45">image      </span>
        <span className="text-amber-200">ghcr.io/genosyn/app:latest</span>
        {"\n"}
        <span className="text-bone-card/45">digest     </span>
        <span className="text-bone-card/65">sha256:a1f3…b20e</span>
        {"\n"}
        <span className="text-bone-card/45">volume     </span>
        <span className="text-bone-card/85">genosyn-data (412 MB)</span>
        {"\n"}
        <span className="text-bone-card/45">port       </span>
        <span className="text-bone-card/85">8471 → 8471</span>
        {"\n"}
        <span className="text-bone-card/45">uptime     </span>
        <span className="text-bone-card/85">17d 4h 22m</span>
        {"\n\n"}
        <span className="text-bone-card/45">open  </span>
        <span className="text-amber-200">http://localhost:8471</span>
      </code>
    </pre>
  );
}
