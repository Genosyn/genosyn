import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Sparkles,
} from "lucide-react";
import {
  COMPANY_OUTCOMES,
  type CompanyOutcome,
  useOutcomeMotion,
} from "@/sections/CompanyDemo";

const OUTCOME_CONTEXT: Record<
  string,
  {
    before: string[];
    value: string[];
    boundary: string;
  }
> = {
  revenue: {
    before: ["Signals disappear into dashboards", "Research starts from zero", "Follow-up lands too late"],
    value: ["Intent watched continuously", "The whole account story assembled", "A personal next step ready to approve"],
    boundary: "A Member approves any external outreach.",
  },
  engineering: {
    before: ["Alerts become another handoff", "Debugging waits for a free engineer", "Context gets rebuilt in every tool"],
    value: ["The incident is investigated immediately", "Repository context stays attached", "A tested patch comes back for review"],
    boundary: "A human reviews and merges every code change.",
  },
  support: {
    before: ["Customers repeat their history", "Important threads sit beside routine mail", "Answers vary by who is online"],
    value: ["Urgency is identified on arrival", "Customer history travels with the thread", "A grounded reply reaches the right owner"],
    boundary: "A Member owns the final send when the thread is sensitive.",
  },
  finance: {
    before: ["Routine matching consumes the morning", "Exceptions hide inside the batch", "Audit context lives in separate systems"],
    value: ["The daily close starts on schedule", "Clean matches finish automatically", "Only the ambiguous item reaches finance"],
    boundary: "A Member classifies anything the books cannot explain.",
  },
};

export function HomepageUseCases() {
  const { outcome, outcomeIndex, phase, selectOutcome } = useOutcomeMotion(false);
  const context = OUTCOME_CONTEXT[outcome.id];

  return (
    <section id="use-cases" className="bg-white">
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-6 sm:py-28 lg:py-36">
        <div className="grid gap-8 border-b border-zinc-200 pb-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
          <div>
            <div className="section-kicker">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Use cases, not feature lists
            </div>
            <h2 className="mt-5 max-w-3xl text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] text-zinc-950 sm:text-6xl">
              Start with the work your company{" "}
              <span className="text-zinc-400">cannot afford to drop.</span>
            </h2>
          </div>
          <p className="max-w-2xl text-pretty text-base leading-7 text-zinc-600 lg:justify-self-end lg:text-lg lg:leading-8">
            Genosyn turns a recurring business outcome into a clear owner, a readable operating
            brief, and a Run that finishes with proof—not another open chat.
          </p>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[21rem_minmax(0,1fr)]">
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none lg:flex-col lg:overflow-visible">
            {COMPANY_OUTCOMES.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => selectOutcome(index)}
                className={`group min-w-[15.5rem] rounded-2xl border p-4 text-left transition lg:min-w-0 ${
                  outcomeIndex === index
                    ? "border-zinc-950 bg-zinc-950 text-white shadow-[0_18px_40px_-26px_rgba(24,24,27,0.7)]"
                    : "border-zinc-200 bg-white text-zinc-950 hover:border-zinc-300 hover:bg-zinc-50"
                }`}
              >
                <span
                  className={`text-[9px] font-bold uppercase tracking-[0.18em] ${
                    outcomeIndex === index ? candidate.accent : "text-zinc-400"
                  }`}
                >
                  {candidate.eyebrow}
                </span>
                <span className="mt-2 flex items-center gap-3">
                  <span className="text-sm font-semibold">{candidate.shortLabel}</span>
                  <ChevronRight
                    className={`ml-auto h-4 w-4 transition ${
                      outcomeIndex === index
                        ? "translate-x-0 text-white"
                        : "-translate-x-1 text-zinc-300 group-hover:translate-x-0 group-hover:text-zinc-600"
                    }`}
                  />
                </span>
                <span
                  className={`mt-2 block text-[10px] leading-4 ${
                    outcomeIndex === index ? "text-zinc-400" : "text-zinc-500"
                  }`}
                >
                  {candidate.title}
                </span>
              </button>
            ))}
          </div>

          <article
            key={outcome.id}
            className="use-case-stage overflow-hidden rounded-[2rem] border border-zinc-200 bg-[#f3f3ee] shadow-[0_28px_80px_-52px_rgba(24,24,27,0.45)]"
          >
            <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(17rem,0.75fr)]">
              <UseCaseRun outcome={outcome} phase={phase} />

              <div className="border-t border-zinc-200 bg-white p-5 sm:p-7 xl:border-l xl:border-t-0">
                <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">
                  What changes
                </div>

                <div className="mt-5">
                  <div className="text-xs font-semibold text-zinc-400">Before Genosyn</div>
                  <ul className="mt-3 space-y-2.5">
                    {context.before.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-[11px] leading-5 text-zinc-500">
                        <span className="mt-2 h-px w-3 shrink-0 bg-zinc-300" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-6 border-t border-zinc-100 pt-5">
                  <div className="text-xs font-semibold text-zinc-950">With an AI Employee</div>
                  <ul className="mt-3 space-y-2.5">
                    {context.value.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-[11px] leading-5 text-zinc-700">
                        <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                  <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-700">
                    Human boundary
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4 text-amber-900">{context.boundary}</p>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function UseCaseRun({ outcome, phase }: { outcome: CompanyOutcome; phase: number }) {
  return (
    <div className="p-4 sm:p-7">
      <div className="flex flex-col gap-5 border-b border-zinc-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className={`text-[9px] font-bold uppercase tracking-[0.18em] ${outcome.accent.replace("300", "700")}`}>
            {outcome.eyebrow} · live run
          </div>
          <h3 className="mt-2 max-w-xl text-2xl font-semibold leading-tight tracking-[-0.035em] text-zinc-950 sm:text-3xl">
            {outcome.title}
          </h3>
          <p className="mt-2 max-w-xl text-xs leading-5 text-zinc-500 sm:text-sm sm:leading-6">
            {outcome.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[9px] font-semibold text-zinc-500 shadow-sm">
          <Clock3 className="h-3 w-3 text-zinc-400" />
          Started automatically
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-xl text-[10px] font-bold ring-1 ${outcome.accentSoft}`}
          >
            {outcome.initials}
          </span>
          <div>
            <div className="text-xs font-semibold text-zinc-950">
              {outcome.employee} · {outcome.role}
            </div>
            <div className="mt-0.5 text-[9px] text-zinc-400">Working from a written Soul and Skills</div>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-emerald-700 sm:inline-flex">
            <Sparkles className="h-2.5 w-2.5" />
            Working
          </span>
        </div>

        <div className="mt-5 space-y-0">
          {outcome.steps.map((step, index) => {
            const Icon = step.icon;
            const isComplete = index < phase;
            const isCurrent = index === phase;
            const isVisible = index <= phase;
            return (
              <div
                key={step.label}
                className={`relative flex gap-3 pb-5 last:pb-0 ${isVisible ? "opacity-100" : "opacity-30"}`}
              >
                {index < outcome.steps.length - 1 && (
                  <span
                    className={`absolute left-[0.9rem] top-8 h-[calc(100%-1.25rem)] w-px ${
                      isComplete ? "bg-emerald-300" : "bg-zinc-200"
                    }`}
                  />
                )}
                <span
                  className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white transition ${
                    isComplete
                      ? "bg-emerald-600 text-white"
                      : isCurrent
                        ? "bg-zinc-950 text-white"
                        : "bg-zinc-100 text-zinc-400"
                  }`}
                >
                  {isComplete ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-zinc-900">{step.label}</span>
                    <span className="ml-auto text-[9px] font-medium text-zinc-400">{step.meta}</span>
                  </span>
                  <span className="mt-1 block text-[10px] leading-4 text-zinc-500">{step.detail}</span>
                  {isCurrent && (
                    <span className="mt-2 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                      Working now
                      <ArrowRight className="h-2.5 w-2.5" />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 rounded-xl bg-zinc-950 px-4 py-3 text-white sm:flex-row sm:items-center">
        <span className="flex items-center gap-2 text-[10px] font-semibold">
          <Check className="h-3.5 w-3.5 text-emerald-300" />
          {outcome.outcome}
        </span>
        <span className="text-[9px] text-zinc-500 sm:ml-auto">Every step captured in the Run</span>
      </div>
    </div>
  );
}
