import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, Copy, Github, Server, ShieldCheck } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { GITHUB_URL } from "@/lib/constants";
import { Claims } from "@/sections/Claims";
import { Button, Container } from "@/sections/Kit";
import { Wall } from "@/sections/Wall";

const COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

export function Hero() {
  return (
    <section className="hero-stage relative overflow-hidden bg-slate-50">
      <div
        aria-hidden
        className="hero-grid pointer-events-none absolute inset-x-0 top-0 h-[45rem]"
      />
      <Container className="relative pb-12 pt-10 sm:pb-16 sm:pt-14 lg:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-10 xl:gap-14">
          <div className="mx-auto min-w-0 max-w-2xl text-center lg:mx-0 lg:text-left">
            <Reveal>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:border-indigo-200 hover:text-indigo-700"
              >
                <Github aria-hidden className="h-3.5 w-3.5" />
                Open source. Yours to run.
                <span className="border-l border-slate-200 pl-2.5 text-slate-500">{`v${__APP_VERSION__}`}</span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </Reveal>

            <Reveal delay={80}>
              <h1 className="mt-7 text-balance text-[clamp(2.4rem,11.5vw,4.6rem)] font-semibold leading-[1.06] tracking-[-0.055em] text-slate-950 lg:text-[clamp(3rem,5vw,4.6rem)]">
                Your company.
                <br />
                <span className="hero-heading-accent inline-block text-indigo-600">
                  Already at work.
                </span>
              </h1>
            </Reveal>

            <Reveal delay={160}>
              <p className="mx-auto mt-6 max-w-[32rem] text-pretty text-base leading-7 text-slate-600 sm:text-lg sm:leading-8 lg:mx-0">
                Replies drafted. Books reconciled. Patches prepared. Your AI Employees do the work,
                with you in control.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
                <Button href="/docs/install" className="min-h-12 px-6">
                  Get started <ArrowRight aria-hidden className="h-4 w-4" />
                </Button>
                <Button href="#roles" variant="secondary" className="min-h-12 px-6">
                  Meet your AI Employees <ArrowDown aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            </Reveal>

            <Reveal delay={240}>
              <ul className="mt-7 flex flex-wrap justify-center gap-x-5 gap-y-3 text-xs text-slate-500 lg:justify-start">
                <li className="inline-flex items-center gap-2">
                  <Server aria-hidden className="h-3.5 w-3.5" />
                  Self-hosted. Your data.
                </li>
                <li className="inline-flex items-center gap-2">
                  <Github aria-hidden className="h-3.5 w-3.5" />
                  Apache 2.0
                </li>
                <li className="inline-flex items-center gap-2">
                  <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
                  Human oversight built in
                </li>
              </ul>
            </Reveal>
          </div>

          <div id="work-demo" className="min-w-0 scroll-mt-24">
            <Wall />
          </div>
        </div>

        <Reveal className="mt-10 grid gap-6 rounded-xl border border-slate-200 bg-white/90 p-5 sm:mt-12 sm:p-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-10">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">
              Your infrastructure. One command away.
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Install Genosyn and give your first AI Employee a role.
            </p>
            <InstallStrip />
          </div>
          <div className="border-t border-slate-100 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <Claims />
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

function InstallStrip() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => window.clearTimeout(reset.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setError(false);
      window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex min-h-12 min-w-0 items-center gap-3 rounded-lg bg-slate-950 px-3 sm:px-4">
        <span aria-hidden className="select-none font-mono text-xs text-indigo-300">
          $
        </span>
        <code className="scrollbar-none min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-slate-100">
          {COMMAND}
        </code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {copied ? (
            <Check aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden className="h-3.5 w-3.5" />
          )}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          <span className="sr-only"> install command</span>
        </button>
      </div>
      {error && (
        <p role="status" className="mt-2 text-xs text-slate-600">
          Select the command above to copy it manually.
        </p>
      )}
    </div>
  );
}
