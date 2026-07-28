import { ArrowRight, Check, Github, ShieldCheck, Sparkles } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { ProductPrototype } from "@/products/ProductPrototype";

const CHECKS = ["MIT licensed", "Self-hosted", "Any AI model", "Human approvals"];
const TEAMS = ["Sales Development", "Engineering", "Support", "Finance", "Operations"];

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-zinc-200 bg-[#f4f4f1]">
      <div aria-hidden className="bg-grid-soft pointer-events-none absolute inset-0 opacity-35" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[42rem] bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.95),transparent_68%)]"
      />

      <div className="relative mx-auto max-w-[92rem] px-5 pb-16 pt-10 sm:px-6 sm:pb-20 sm:pt-20 lg:pb-24 lg:pt-24">
        <div className="mx-auto max-w-5xl text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/80 px-3.5 py-1.5 text-[11px] font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-400 hover:bg-white"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950 text-white">
              <Sparkles className="h-3 w-3" />
            </span>
            Open-source company operating system
            <span className="text-zinc-300">·</span>v{__APP_VERSION__}
            <ArrowRight className="h-3.5 w-3.5 text-zinc-400 transition group-hover:translate-x-0.5" />
          </a>

          <h1 className="mt-7 text-balance text-[3.15rem] font-semibold leading-[0.92] tracking-[-0.065em] text-zinc-950 sm:mt-8 sm:text-[5rem] lg:text-[6.4rem]">
            Run your company with <span className="text-zinc-500">AI employees.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-3xl text-pretty text-base leading-7 text-zinc-600 sm:mt-7 sm:text-xl sm:leading-8">
            Sales, engineering, support, finance, and operations—all in one self-hosted workspace
            where people and AI Employees share the same context, tools, and review queues.
          </p>

          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:mt-9 sm:flex-row">
            <a
              href="#quickstart"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3.5 text-sm font-semibold text-white shadow-[0_14px_30px_-14px_rgba(24,24,27,0.75)] transition hover:-translate-y-0.5 hover:bg-zinc-800 sm:w-auto"
            >
              Run it on your server
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white px-6 py-3.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-400 sm:w-auto"
            >
              <Github className="h-4 w-4" />
              View on GitHub
            </a>
          </div>

          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-semibold text-zinc-500 sm:mt-8">
            {CHECKS.map((check) => (
              <li key={check} className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-emerald-600" />
                {check}
              </li>
            ))}
          </ul>
        </div>

        <div className="mx-auto mt-10 max-w-[86rem] sm:mt-16">
          <div className="mb-4 flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">
                <span className="prototype-live-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />A
                company working in real time
              </div>
              <p className="mt-1.5 text-sm font-medium text-zinc-800">
                Watch the work move. The showcase runs itself.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-medium text-zinc-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
              Sensitive actions pause for approval
            </div>
          </div>

          <ProductPrototype compact />

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {TEAMS.map((team) => (
              <span
                key={team}
                className="rounded-full border border-zinc-300 bg-white/60 px-3 py-1.5 text-[10px] font-semibold text-zinc-500"
              >
                {team}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
