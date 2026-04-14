type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Hire an Employee",
    body: "Give them a name and a role. Genosyn scaffolds their folder on disk and drops a starter SOUL.md in place.",
  },
  {
    number: "02",
    title: "Write their Soul",
    body: "Edit SOUL.md to describe how they think, what they value, and what they will never do. Add skills as markdown.",
  },
  {
    number: "03",
    title: "Schedule their Routines",
    body: "Point a cron expression at a brief. Genosyn registers the job, runs it, and keeps the log.",
  },
];

export function HowItWorks() {
  return (
    <section className="border-y border-slate-200 bg-slate-50/60">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            How it works.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            Three steps. Every artifact is a file in your repo.
          </p>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
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
