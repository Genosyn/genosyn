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
    title: "Hire an employee",
    body: "Give them a name and a role. Genosyn seeds a starter Soul, hooks up their credentials directory, and opens the editor.",
  },
  {
    number: "02",
    title: "Write their Soul",
    body: "Describe how they think, what they value, and what they will never do. Attach skills as markdown playbooks.",
  },
  {
    number: "03",
    title: "Schedule a routine",
    body: "Point a cron expression at a brief. Genosyn registers the job, runs it on time, and keeps the log.",
  },
];

const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

export function HowItWorks() {
  return (
    <section id="quickstart" className="border-y border-slate-200 bg-slate-50/60">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
            <Terminal className="h-3.5 w-3.5 text-indigo-500" />
            Quickstart
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            One command. A whole company.
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

        <ol className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.number} className="relative">
              {i < STEPS.length - 1 && (
                <div
                  aria-hidden
                  className="absolute left-full top-10 hidden h-px w-full -translate-x-1/2 bg-gradient-to-r from-indigo-200 via-indigo-200 to-transparent md:block"
                />
              )}
              <div className="relative rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 font-mono text-xs font-semibold text-white shadow-sm">
                    {step.number}
                  </div>
                  <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
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
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl shadow-slate-900/10">
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
