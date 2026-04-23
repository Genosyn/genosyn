import { Cpu, Database, GitBranch, KeyRound, Server, Users } from "lucide-react";

const PLATFORM = [
  {
    icon: Users,
    title: "Build a roster, not a single agent.",
    body: "Hire as many employees as you need. Each has their own credentials, working directory, and audit trail — no shared prompts, no session bleed.",
  },
  {
    icon: Cpu,
    title: "Bring your own brain.",
    body: "Plug in claude-code, codex, or opencode per employee. Assign a different model per routine. Costs show up on the provider's dashboard, not ours.",
  },
  {
    icon: Server,
    title: "SQLite today, Postgres tomorrow.",
    body: "One config file, one process, one database. Flip a flag when you outgrow SQLite. No migrations needed for your workflow.",
  },
];

const STATS = [
  { icon: Database, label: "One database", value: "SQLite → Postgres" },
  { icon: GitBranch, label: "Open source", value: "MIT · fork it" },
  { icon: KeyRound, label: "Your keys", value: "Stored on your disk" },
];

export function Features() {
  return (
    <section id="platform" className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          The platform
        </div>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Opinionated where it matters.
          <br className="hidden sm:block" /> Flexible where you need it.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          One runtime for a whole company. The defaults get you going in a
          minute; the escape hatches are there when you grow.
        </p>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
        {PLATFORM.map((f) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title}
              className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
            >
              <div
                aria-hidden
                className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-indigo-50 opacity-0 blur-2xl transition group-hover:opacity-80"
              />
              <div className="relative">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-900">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-2 sm:grid-cols-3">
        {STATS.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-100"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                  {s.label}
                </div>
                <div className="truncate text-sm font-medium text-slate-900">{s.value}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
