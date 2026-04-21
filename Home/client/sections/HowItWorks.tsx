import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Hire an Employee",
    body: "Give them a name and a role. Genosyn seeds a starter Soul, hooks up their credential directory, and opens the editor.",
  },
  {
    number: "02",
    title: "Write their Soul",
    body: "Edit their Soul to describe how they think, what they value, and what they will never do. Add skills as markdown playbooks.",
  },
  {
    number: "03",
    title: "Schedule a Routine",
    body: "Point a cron expression at a brief. Genosyn registers the job, runs it, and keeps the log.",
  },
];

const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

export function HowItWorks() {
  return (
    <section id="quickstart" className="border-y border-slate-200 bg-slate-50/60">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            One command. A company.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            The installer pulls the latest Docker image and starts Genosyn on{" "}
            <code className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[12px] text-slate-800">
              localhost:8471
            </code>
            . Re-run any time to upgrade.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <InstallTerminal />
          <p className="mt-3 text-center text-xs text-slate-500">
            Requires Docker.{" "}
            <a
              href="/install.sh"
              className="font-medium text-slate-700 underline-offset-2 hover:underline"
            >
              Read the script
            </a>{" "}
            before piping it to your shell.
          </p>
        </div>

        <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-3">
          {STEPS.map((step) => (
            <div
              key={step.number}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="text-xs font-semibold tracking-widest text-indigo-600">
                STEP {step.number}
              </div>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function InstallTerminal() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked in non-secure contexts; the visible command
      // is still selectable as a fallback.
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-xl shadow-slate-900/10">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
        <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
        <div className="ml-3 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          <Terminal className="h-3.5 w-3.5" />
          install
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy install command"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:border-slate-700 hover:text-white"
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
      <pre className="overflow-x-auto px-6 py-5 font-mono text-[13px] leading-6 text-slate-200">
        <code>
          <span className="text-slate-500">$ </span>
          <span className="text-slate-100">curl -fsSL </span>
          <span className="text-indigo-300">https://genosyn.com/install.sh</span>
          <span className="text-slate-100"> | bash</span>
          {"\n\n"}
          <span className="text-slate-500">→ </span>
          <span className="text-slate-300">Pulling ghcr.io/genosyn/app:latest</span>
          {"\n"}
          <span className="text-slate-500">→ </span>
          <span className="text-slate-300">Starting &lsquo;genosyn&rsquo; on port 8471</span>
          {"\n"}
          <span className="text-emerald-400">✓ </span>
          <span className="text-slate-300">Genosyn is running.</span>
          {"\n\n"}
          <span className="text-slate-500">   Open  </span>
          <span className="text-indigo-300">http://localhost:8471</span>
        </code>
      </pre>
    </div>
  );
}
