import {
  ArrowDown,
  Check,
  CircleDollarSign,
  Code2,
  Headphones,
  Radar,
  ShieldCheck,
  Sparkles,
  Target,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";

type LoopStep = {
  number: string;
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  example: string;
};

const LOOP_STEPS: LoopStep[] = [
  {
    number: "01",
    icon: Radar,
    label: "Notice",
    title: "Work begins from reality.",
    body: "A schedule, product signal, email, alert, or Member starts the Run.",
    example: "A high-intent account crosses a usage threshold.",
  },
  {
    number: "02",
    icon: Target,
    label: "Understand",
    title: "Context arrives with the job.",
    body: "The employee reads its Soul, applies the right Skills, and uses only its Grants.",
    example: "Usage, account history, and the latest conversation join one brief.",
  },
  {
    number: "03",
    icon: Wrench,
    label: "Do",
    title: "Tools turn intent into work.",
    body: "The employee updates records, prepares artifacts, talks to systems, and records every step.",
    example: "A personal next step is prepared with sources attached.",
  },
  {
    number: "04",
    icon: ShieldCheck,
    label: "Close",
    title: "People stay at the judgment edge.",
    body: "Safe work completes. Sensitive work pauses behind an explicit approval gate.",
    example: "A Member reviews the outreach before anything leaves the company.",
  },
];

const ROSTER = [
  {
    initials: "NR",
    name: "Nia",
    role: "Revenue operator",
    icon: Target,
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    outcome: "3 high-intent accounts briefed",
    note: "One follow-up waiting for review",
  },
  {
    initials: "SE",
    name: "Sam",
    role: "Software engineer",
    icon: Code2,
    tone: "bg-sky-50 text-sky-700 ring-sky-200",
    outcome: "Checkout patch tested",
    note: "Focused diff ready to merge",
  },
  {
    initials: "MS",
    name: "Maya",
    role: "Support specialist",
    icon: Headphones,
    tone: "bg-violet-50 text-violet-700 ring-violet-200",
    outcome: "14 threads triaged",
    note: "Two sensitive replies routed",
  },
  {
    initials: "MF",
    name: "Mira",
    role: "Bookkeeper",
    icon: CircleDollarSign,
    tone: "bg-amber-50 text-amber-700 ring-amber-200",
    outcome: "41 charges reconciled",
    note: "One exception needs classification",
  },
];

export function ValueLoop() {
  return (
    <section id="how-it-works" className="overflow-hidden bg-zinc-950 text-white">
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-6 sm:py-28 lg:py-36">
        <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
          <div>
            <div className="section-kicker section-kicker-dark">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
              The operating loop
            </div>
            <h2 className="mt-5 max-w-3xl text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl">
              From signal to outcome.{" "}
              <span className="text-zinc-600">One accountable Run.</span>
            </h2>
          </div>
          <p className="max-w-2xl text-pretty text-base leading-7 text-zinc-400 lg:justify-self-end lg:text-lg lg:leading-8">
            Most automation breaks at the seams: a trigger in one tool, context in another, and a
            person chasing the handoff. Genosyn keeps the full loop together.
          </p>
        </div>

        <div className="relative mt-14 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div
            aria-hidden
            className="operating-loop-line pointer-events-none absolute left-[9%] right-[9%] top-[2.6rem] hidden h-px bg-white/10 xl:block"
          >
            <span className="operating-loop-pulse absolute -top-0.5 h-1 w-16 rounded-full bg-emerald-300" />
          </div>
          {LOOP_STEPS.map((step, index) => (
            <article
              key={step.number}
              className="group relative rounded-[1.5rem] border border-white/10 bg-white/[0.035] p-5 transition hover:border-white/20 hover:bg-white/[0.055] sm:p-6"
            >
              <div className="flex items-center gap-3">
                <span className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-zinc-950 text-zinc-300 shadow-[0_0_0_8px_#09090b]">
                  <step.icon className="h-4 w-4" />
                </span>
                <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-emerald-300">
                  {step.label}
                </span>
                <span className="ml-auto font-mono text-[9px] text-zinc-700">{step.number}</span>
              </div>
              <h3 className="mt-8 text-lg font-semibold tracking-[-0.02em] text-white">{step.title}</h3>
              <p className="mt-2 text-xs leading-5 text-zinc-400">{step.body}</p>
              <div className="mt-6 border-t border-white/10 pt-4">
                <p className="text-[10px] leading-5 text-zinc-500">{step.example}</p>
              </div>
              {index < LOOP_STEPS.length - 1 && (
                <ArrowDown className="absolute -bottom-5 left-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 text-zinc-700 md:hidden" />
              )}
            </article>
          ))}
        </div>

        <div className="mt-10 grid gap-3 border-t border-white/10 pt-8 sm:grid-cols-3">
          {[
            ["No orphaned context", "The brief, tools, decisions, and result stay attached."],
            ["No invisible autonomy", "Every action is readable in the Run transcript."],
            ["No forced model", "Choose Claude, GPT, or your own compatible endpoint."],
          ].map(([title, body]) => (
            <div key={title} className="flex gap-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
              <div>
                <div className="text-xs font-semibold text-zinc-200">{title}</div>
                <div className="mt-1 text-[10px] leading-5 text-zinc-500">{body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function OutcomeRoster() {
  return (
    <section className="overflow-hidden bg-[#f1f1eb]">
      <div className="mx-auto max-w-[92rem] px-5 py-24 sm:px-6 sm:py-28 lg:py-36">
        <div className="mx-auto max-w-4xl text-center">
          <div className="section-kicker">
            <UsersRound className="h-3.5 w-3.5" />
            A roster, not a chatbot
          </div>
          <h2 className="mt-5 text-balance text-4xl font-semibold leading-[0.98] tracking-[-0.055em] text-zinc-950 sm:text-6xl">
            Measure the team in{" "}
            <span className="text-zinc-400">completed work.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-7 text-zinc-600 sm:text-lg sm:leading-8">
            Each AI Employee owns a role, wakes up for Routines, and reports outcomes into the same
            workspace as your Members.
          </p>
        </div>

        <div className="relative mx-auto mt-14 max-w-6xl">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-20 top-12 h-56 rounded-full bg-white/70 blur-3xl"
          />
          <div className="relative grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {ROSTER.map((employee, index) => (
              <article
                key={employee.name}
                className={`roster-card rounded-[1.5rem] border border-zinc-200 bg-white p-5 shadow-[0_18px_50px_-38px_rgba(24,24,27,0.35)] ${
                  index % 2 === 1 ? "xl:translate-y-6" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl text-[10px] font-bold ring-1 ${employee.tone}`}
                  >
                    {employee.initials}
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-zinc-950">{employee.name}</div>
                    <div className="mt-0.5 text-[9px] text-zinc-400">{employee.role}</div>
                  </div>
                  <employee.icon className="ml-auto h-4 w-4 text-zinc-300" />
                </div>

                <div className="mt-8 text-[9px] font-bold uppercase tracking-[0.17em] text-zinc-400">
                  Latest outcome
                </div>
                <div className="mt-2 text-lg font-semibold leading-6 tracking-[-0.025em] text-zinc-950">
                  {employee.outcome}
                </div>
                <div className="mt-3 flex items-start gap-2 border-t border-zinc-100 pt-3 text-[10px] leading-4 text-zinc-500">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                  {employee.note}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="mx-auto mt-20 grid max-w-6xl gap-5 rounded-[2rem] border border-zinc-200 bg-white p-6 shadow-sm md:grid-cols-[1fr_auto_1fr] md:items-center sm:p-8">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">
              The old operating model
            </div>
            <p className="mt-2 text-lg font-semibold tracking-[-0.025em] text-zinc-400">
              People chase tools, context, and follow-ups.
            </p>
          </div>
          <span className="hidden h-16 w-px bg-zinc-200 md:block" />
          <div className="md:text-right">
            <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-emerald-700">
              The Genosyn operating model
            </div>
            <p className="mt-2 text-lg font-semibold tracking-[-0.025em] text-zinc-950">
              AI Employees carry the work to a clear finish.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
