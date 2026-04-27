import { useState } from "react";
import { Check, Copy } from "lucide-react";

type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Hire your first employee.",
    body: "Open the app at localhost:8471, give them a name, and pick a model. Genosyn opens the Soul editor and seeds a starter constitution you can tear up.",
  },
  {
    number: "02",
    title: "Write their Soul.",
    body: "Tell them how they think, what they value, what they will refuse. Add skills as named markdown playbooks. Save. There is no other prompt to discover.",
  },
  {
    number: "03",
    title: "Schedule their first routine.",
    body: "Point a cron expression at a brief. Genosyn registers the job, fires it on time, and writes the captured run to a log you can read line by line.",
  },
];

const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

export function HowItWorks() {
  return (
    <section id="quickstart" className="border-b border-ink bg-bone">
      <div className="mx-auto max-w-[1200px] px-6 pt-20 pb-20 sm:pb-24">
        <div className="grid items-end gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="flex items-baseline gap-4 font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            <span className="text-ink">§ 04</span>
            <span className="text-ink-mute">/</span>
            <span>quickstart</span>
          </div>
          <div>
            <h2 className="text-[clamp(2rem,4.4vw,3.5rem)] font-medium leading-[1] tracking-[-0.025em] text-ink">
              One command.
              <br />
              <span className="serif-italic text-accent">A whole company on your laptop.</span>
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-[1.55] text-ink-soft">
              The installer pulls the latest image and starts Genosyn on{" "}
              <code className="font-mono text-ink">localhost:8471</code>. Re-run any
              time to upgrade. Your data stays in a Docker volume on{" "}
              <em className="serif-italic not-italic font-medium text-ink">your</em>{" "}
              machine.
            </p>
          </div>
        </div>

        <div className="mt-12">
          <InstallTerminal />
          <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
            Requires Docker.{" "}
            <a
              href="/install.sh"
              className="text-ink underline-offset-4 hover:text-accent hover:underline"
            >
              Read the script
            </a>{" "}
            before piping it.
          </p>
        </div>

        <ol className="mt-16 grid grid-cols-1 gap-0 border-t border-ink md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li
              key={step.number}
              className={`relative flex flex-col gap-4 border-b border-ink px-6 py-10 md:border-b-0 ${
                i < STEPS.length - 1 ? "md:border-r md:border-ink" : ""
              }`}
            >
              <div className="flex items-baseline gap-4">
                <span className="serif-italic text-[3rem] leading-none text-accent">
                  {step.number}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-soft">
                  step
                </span>
              </div>
              <h3 className="font-serif text-2xl leading-[1.1] text-ink">
                {step.title}
              </h3>
              <p className="text-base leading-[1.6] text-ink-soft">{step.body}</p>
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
      // Clipboard may be blocked in non-secure contexts; the visible command
      // is still selectable as a fallback.
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-center justify-between border-b border-ink pb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-soft">
        <span className="text-ink">$ install</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy install command"
          className="inline-flex items-center gap-1.5 text-ink-soft hover:text-accent"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto border border-ink bg-ink px-6 py-6 font-mono text-[14px] leading-[1.7] text-bone-card">
        <code>
          <span className="text-bone-card/45">$ </span>
          <span className="text-bone-card">curl -fsSL </span>
          <span className="text-amber-200">https://genosyn.com/install.sh</span>
          <span className="text-bone-card"> | bash</span>
          {"\n\n"}
          <span className="text-bone-card/45">→ </span>
          <span className="text-bone-card/85">pulling ghcr.io/genosyn/app:latest</span>
          {"\n"}
          <span className="text-bone-card/45">→ </span>
          <span className="text-bone-card/85">starting &lsquo;genosyn&rsquo; on port 8471</span>
          {"\n"}
          <span className="text-emerald-300">✓ </span>
          <span className="text-bone-card/85">genosyn is running.</span>
          {"\n\n"}
          <span className="text-bone-card/45">   open  </span>
          <span className="text-amber-200">http://localhost:8471</span>
        </code>
      </pre>
    </div>
  );
}
