import { Terminal } from "lucide-react";

type Step = {
  number: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    title: "Hire an Employee",
    body: "Give them a name and a role. Genosyn scaffolds the folder on disk and drops a starter SOUL.md in place.",
  },
  {
    number: "02",
    title: "Write their Soul",
    body: "Edit SOUL.md to describe how they think, what they value, and what they will never do. Add skills as markdown.",
  },
  {
    number: "03",
    title: "Schedule a Routine",
    body: "Point a cron expression at a brief. Genosyn registers the job, runs it, and keeps the log.",
  },
];

export function HowItWorks() {
  return (
    <section id="quickstart" className="border-y border-slate-200 bg-slate-50/60">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            One clone. One command. A company.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            Every artifact is a file in your repo. Nothing to configure before you run it.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-3xl">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-xl shadow-slate-900/10">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
              <div className="ml-3 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                <Terminal className="h-3.5 w-3.5" />
                bash
              </div>
            </div>
            <pre className="overflow-x-auto px-6 py-5 font-mono text-[13px] leading-6 text-slate-200">
              <code>
                <span className="text-slate-500">$ </span>
                <span className="text-slate-200">docker run -d --name genosyn -p 8471:8471 \</span>
                {"\n"}
                <span className="text-slate-500">    </span>
                <span className="text-slate-200">-v genosyn-data:/app/data \</span>
                {"\n"}
                <span className="text-slate-500">    </span>
                <span className="text-indigo-300">ghcr.io/genosyn/app:latest</span>
                {"\n\n"}
                <span className="text-emerald-400">[genosyn]</span>
                <span className="text-slate-300"> listening on :8471</span>
                {"\n"}
                <span className="text-slate-500">→ open </span>
                <span className="text-indigo-300">http://localhost:8471</span>
              </code>
            </pre>
          </div>
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
