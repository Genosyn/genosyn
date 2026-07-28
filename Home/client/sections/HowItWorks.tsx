import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";

type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Name the outcome",
    body: "Start with one recurring job your company already understands: qualify intent, triage support, review reliability, or close the day.",
  },
  {
    number: "02",
    title: "Define the owner",
    body: "Create an AI Employee, write the Soul that guides decisions, add the Skills for the job, and connect the context it needs.",
  },
  {
    number: "03",
    title: "Choose the boundary",
    body: "Schedule the Routine, decide which actions need approval, and let the employee carry the work to a readable result.",
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
    <section id="quickstart" className="relative border-t border-zinc-200 bg-[#f1f1eb]">
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-6 sm:py-28 lg:py-36">
        <div className="mx-auto max-w-3xl text-center">
          <div className="section-kicker">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Start small
          </div>
          <h2 className="mt-5 text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] text-zinc-950 sm:text-6xl">
            One outcome first.{" "}
            <span className="text-zinc-400">The roster can follow.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-7 text-zinc-600 sm:text-lg sm:leading-8">
            Install Genosyn on your infrastructure, give one recurring job a clear owner, and add
            more AI Employees when the first one earns its place.
          </p>
        </div>

        <ol className="mx-auto mt-14 grid max-w-6xl grid-cols-1 gap-3 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.number} className="relative">
              {i < STEPS.length - 1 && (
                <div
                  aria-hidden
                  className="absolute left-full top-10 hidden h-px w-full -translate-x-1/2 md:block"
                >
                  <div className="h-px w-full bg-gradient-to-r from-zinc-200 to-transparent" />
                </div>
              )}
              <div className="relative h-full rounded-[1.5rem] border border-zinc-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 sm:p-7">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-950 font-mono text-xs font-semibold text-white shadow-card">
                    {step.number}
                  </div>
                  <h3 className="text-base font-semibold tracking-[-0.02em] text-zinc-950">{step.title}</h3>
                </div>
                <p className="mt-5 text-xs leading-6 text-zinc-500">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mx-auto mt-14 max-w-3xl">
          <div className="mb-3 flex items-center justify-between px-1 text-[10px] font-semibold text-zinc-500">
            <span>Run Genosyn on your server</span>
            <span className="font-mono">localhost:8471</span>
          </div>
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
