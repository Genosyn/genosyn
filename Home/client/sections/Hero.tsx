import { ArrowDownRight, ArrowRight, Check, ShieldCheck } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import {
  CompanyDemo,
  OutcomeTabs,
  useOutcomeMotion,
} from "@/sections/CompanyDemo";

const TRUST_MARKERS = ["MIT licensed", "Runs on your infrastructure", "Bring any AI model"];

export function Hero() {
  const { outcome, outcomeIndex, phase, selectOutcome } = useOutcomeMotion(true);

  return (
    <section className="relative overflow-hidden border-b border-zinc-200 bg-[#f1f1eb]">
      <div aria-hidden className="homepage-grid pointer-events-none absolute inset-0 opacity-55" />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-48 top-40 h-80 w-80 rounded-full bg-emerald-200/30 blur-3xl"
      />

      <div className="relative mx-auto grid min-h-[calc(100svh-4.5rem)] max-w-[94rem] items-center gap-12 px-5 py-14 sm:px-6 sm:py-20 lg:grid-cols-[0.82fr_1.18fr] lg:gap-10 lg:py-16 xl:gap-16">
        <div className="mx-auto max-w-2xl text-center lg:mx-0 lg:text-left">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-zinc-600 shadow-sm transition hover:border-zinc-400 hover:bg-white"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Open source · v{__APP_VERSION__}
            <ArrowRight className="h-3 w-3 text-zinc-400 transition group-hover:translate-x-0.5" />
          </a>

          <h1 className="mt-7 text-balance text-[3.35rem] font-semibold leading-[0.91] tracking-[-0.07em] text-zinc-950 sm:text-[4.7rem] lg:text-[4.9rem] xl:text-[5.75rem]">
            Give every outcome <span className="text-zinc-500">an owner.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-pretty text-base leading-7 text-zinc-600 sm:text-lg sm:leading-8 lg:mx-0">
            Build AI Employees for the work that never stops. They wake up on schedule, work across
            your company, and bring people in exactly where judgment matters.
          </p>

          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <a
              href="#quickstart"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3.5 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(24,24,27,0.8)] transition hover:-translate-y-0.5 hover:bg-zinc-800"
            >
              Meet your first AI Employee
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </a>
            <a
              href="#use-cases"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-300 bg-white/75 px-6 py-3.5 text-sm font-semibold text-zinc-800 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-400 hover:bg-white"
            >
              See the work
              <ArrowDownRight className="h-4 w-4 text-zinc-500" />
            </a>
          </div>

          <ul className="mt-7 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[10px] font-semibold text-zinc-500 lg:justify-start">
            {TRUST_MARKERS.map((marker) => (
              <li key={marker} className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-emerald-700" />
                {marker}
              </li>
            ))}
          </ul>

          <div className="mt-8 hidden items-center gap-3 border-t border-zinc-300/80 pt-5 text-left lg:flex">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-300 bg-white text-emerald-700 shadow-sm">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <p className="max-w-sm text-[11px] leading-5 text-zinc-500">
              Sensitive actions wait behind approval gates. Every decision and tool action stays in
              a readable Run.
            </p>
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-4 px-1">
            <div>
              <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                <span className="company-demo-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
                One company, working now
              </div>
              <p className="mt-1 text-xs font-medium text-zinc-700">
                Pick an outcome and watch the handoff disappear.
              </p>
            </div>
          </div>
          <OutcomeTabs
            activeIndex={outcomeIndex}
            onSelect={selectOutcome}
            className="mb-3"
          />
          <CompanyDemo outcome={outcome} phase={phase} compact />
        </div>
      </div>
    </section>
  );
}
