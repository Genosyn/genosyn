import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Hire your first employee",
    body: "Open the app, give them a name, pick a model. Genosyn opens the Soul editor and seeds a starter constitution you can tear up.",
  },
  {
    number: "02",
    title: "Write their Soul",
    body: "Tell them how they think, what they value, and what they will refuse. Add skills as named markdown playbooks. Save.",
  },
  {
    number: "03",
    title: "Schedule a routine",
    body: "Point a cron expression at a brief. Genosyn registers the job, runs it on time, and writes a Run log you can review.",
  },
];

type InstallTab = "curl" | "docker";

const INSTALL_COMMANDS: Record<InstallTab, string> = {
  curl: "curl -fsSL https://genosyn.com/install.sh | bash",
  docker: `docker run -d \\
  --name genosyn \\
  --restart unless-stopped \\
  -p 8471:8471 \\
  -v genosyn-data:/app/data \\
  ghcr.io/genosyn/app:latest`,
};

export function HowItWorks() {
  return (
    <section id="quickstart" className="relative border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>Quickstart</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            One command. A whole company.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            The installer pulls the latest Docker image and starts Genosyn on{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[13px] text-zinc-800">
              localhost:8471
            </code>
            . Re-run any time to upgrade.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <InstallTerminal />
          <p className="mt-3 text-center text-xs text-zinc-500">
            Requires Docker.{" "}
            <a
              href="/install.sh"
              className="font-medium text-zinc-700 underline-offset-2 hover:underline"
            >
              Read the script
            </a>{" "}
            before piping it.
          </p>
        </div>

        <ol className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-5 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.number} className="relative">
              {i < STEPS.length - 1 && (
                <div
                  aria-hidden
                  className="absolute left-full top-12 hidden h-px w-full -translate-x-1/2 md:block"
                >
                  <div className="h-px w-full bg-gradient-to-r from-zinc-200 to-transparent" />
                </div>
              )}
              <div className="relative h-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-lift">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 font-mono text-sm font-semibold text-white shadow-card">
                    {step.number}
                  </div>
                  <h3 className="text-base font-semibold text-zinc-950">
                    {step.title}
                  </h3>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-zinc-600">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function InstallTerminal() {
  const [tab, setTab] = useState<InstallTab>("curl");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMANDS[tab]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the command stays selectable.
    }
  };

  const selectTab = (next: InstallTab) => {
    if (next === tab) return;
    setTab(next);
    setCopied(false);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-900 bg-zinc-950 shadow-lift">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <div role="tablist" aria-label="Install method" className="ml-3 flex items-center gap-1">
          <TabButton
            active={tab === "curl"}
            controls="install-panel"
            onClick={() => selectTab("curl")}
          >
            curl
          </TabButton>
          <TabButton
            active={tab === "docker"}
            controls="install-panel"
            onClick={() => selectTab("docker")}
          >
            Docker
          </TabButton>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-white/20 hover:text-white"
          aria-label="Copy install command"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre
        id="install-panel"
        role="tabpanel"
        className="overflow-x-auto px-6 py-5 font-mono text-[13.5px] leading-7 text-zinc-200"
      >
        <code>{tab === "curl" ? <CurlBody /> : <DockerBody />}</code>
      </pre>
    </div>
  );
}

function TabButton({
  active,
  controls,
  onClick,
  children,
}: {
  active: boolean;
  controls: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
        active
          ? "bg-white/10 text-white"
          : "text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function CurlBody() {
  return (
    <>
      <span className="text-zinc-500">$ </span>
      <span className="text-zinc-100">curl -fsSL </span>
      <span className="text-emerald-300">https://genosyn.com/install.sh</span>
      <span className="text-zinc-100"> | bash</span>
      {"\n\n"}
      <span className="text-zinc-500">→ </span>
      <span className="text-zinc-300">Pulling ghcr.io/genosyn/app:latest</span>
      {"\n"}
      <span className="text-zinc-500">→ </span>
      <span className="text-zinc-300">Starting genosyn on port 8471</span>
      {"\n"}
      <span className="text-emerald-400">✓ </span>
      <span className="text-zinc-300">Genosyn is running.</span>
      {"\n\n"}
      <span className="text-zinc-500">   Open  </span>
      <span className="text-emerald-300 underline-offset-2">http://localhost:8471</span>
      <ArrowIcon />
    </>
  );
}

function DockerBody() {
  return (
    <>
      <span className="text-zinc-500">$ </span>
      <span className="text-zinc-100">docker run -d \</span>
      {"\n"}
      <span className="text-zinc-100">    --name </span>
      <span className="text-emerald-300">genosyn</span>
      <span className="text-zinc-100"> \</span>
      {"\n"}
      <span className="text-zinc-100">    --restart unless-stopped \</span>
      {"\n"}
      <span className="text-zinc-100">    -p </span>
      <span className="text-emerald-300">8471:8471</span>
      <span className="text-zinc-100"> \</span>
      {"\n"}
      <span className="text-zinc-100">    -v </span>
      <span className="text-emerald-300">genosyn-data:/app/data</span>
      <span className="text-zinc-100"> \</span>
      {"\n"}
      <span className="text-zinc-100">    </span>
      <span className="text-emerald-300">ghcr.io/genosyn/app:latest</span>
      {"\n\n"}
      <span className="text-emerald-400">✓ </span>
      <span className="text-zinc-300">Genosyn is running.</span>
      {"\n\n"}
      <span className="text-zinc-500">   Open  </span>
      <span className="text-emerald-300 underline-offset-2">http://localhost:8471</span>
      <ArrowIcon />
    </>
  );
}

function ArrowIcon() {
  return (
    <span className="ml-2 inline-flex translate-y-[2px] items-center text-zinc-500">
      <ArrowRight className="h-3 w-3" />
    </span>
  );
}
