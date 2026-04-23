import { CalendarClock, FileText, Sparkles } from "lucide-react";

export function Primitives() {
  return (
    <section id="primitives" className="relative border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
            The primitives
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Three things an employee needs.
            <br className="hidden sm:block" /> All of them in markdown.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            Soul says who they are. Skills describe what they know. Routines
            are when they work. Every line is editable, auditable, yours.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <SoulCard />
          <SkillsCard />
          <RoutinesCard />
        </div>
      </div>
    </section>
  );
}

function PrimitiveShell({
  label,
  title,
  blurb,
  children,
}: {
  label: string;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-600">
        <span>{label}</span>
        <span className="font-mono text-[10px] tracking-normal text-slate-400">*.md</span>
      </div>
      <div className="flex-1 px-5 pt-5">
        <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{blurb}</p>
      </div>
      <div className="mt-5 px-5 pb-5">{children}</div>
    </div>
  );
}

function SoulCard() {
  return (
    <PrimitiveShell
      label="Soul"
      title="A constitution, not a prompt."
      blurb="Values, voice, what they refuse. One markdown file the whole roster lives by."
    >
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 font-mono text-[12px] leading-6 text-slate-600">
        <div className="flex items-center gap-1.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          <FileText className="h-3 w-3" />
          alex-brand · soul.md
        </div>
        <div className="text-slate-900"># Alex Brand</div>
        <div className="text-slate-500">Senior brand writer.</div>
        <div className="mt-3 font-semibold text-slate-900">## Values</div>
        <div>- Concrete over clever.</div>
        <div>- Shorter is braver.</div>
        <div className="mt-3 font-semibold text-slate-900">## Never</div>
        <div>- Promise features not shipped.</div>
      </div>
    </PrimitiveShell>
  );
}

function SkillsCard() {
  const skills = [
    { name: "write-weekly-digest", tag: "Writing", ring: "ring-indigo-100 text-indigo-700 bg-indigo-50" },
    { name: "triage-inbox", tag: "Ops", ring: "ring-emerald-100 text-emerald-700 bg-emerald-50" },
    { name: "draft-release-notes", tag: "Writing", ring: "ring-indigo-100 text-indigo-700 bg-indigo-50" },
    { name: "reconcile-stripe", tag: "Finance", ring: "ring-amber-100 text-amber-700 bg-amber-50" },
  ];
  return (
    <PrimitiveShell
      label="Skills"
      title="Reusable playbooks."
      blurb="Each skill is a named markdown playbook. Compose them across employees and share them between teams."
    >
      <div className="space-y-2">
        {skills.map((s) => (
          <div
            key={s.name}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
              <span className="truncate font-mono text-[12px] text-slate-700">{s.name}</span>
            </div>
            <span
              className={`ml-2 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${s.ring}`}
            >
              {s.tag}
            </span>
          </div>
        ))}
      </div>
    </PrimitiveShell>
  );
}

function RoutinesCard() {
  const routines = [
    { name: "Morning standup digest", cron: "0 7 * * 1-5", status: "running" },
    { name: "Inbox triage", cron: "0 * * * *", status: "queued" },
    { name: "Friday weekly report", cron: "0 17 * * 5", status: "idle" },
  ];
  const statusStyles: Record<string, string> = {
    running: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    queued: "bg-amber-50 text-amber-700 ring-amber-200",
    idle: "bg-slate-100 text-slate-600 ring-slate-200",
  };
  return (
    <PrimitiveShell
      label="Routines"
      title="Work on a cron."
      blurb="Scheduled recurring work with a markdown brief. Every run is logged, every log is auditable."
    >
      <div className="space-y-2">
        {routines.map((r) => (
          <div
            key={r.name}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CalendarClock className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                <span className="truncate text-sm font-medium text-slate-800">
                  {r.name}
                </span>
              </div>
              <span
                className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${statusStyles[r.status]}`}
              >
                {r.status}
              </span>
            </div>
            <div className="mt-1 pl-5 font-mono text-[11px] text-slate-500">
              {r.cron}
            </div>
          </div>
        ))}
      </div>
    </PrimitiveShell>
  );
}

