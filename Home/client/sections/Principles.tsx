import { FileCode2, GitBranch, Server } from "lucide-react";

const PRINCIPLES = [
  {
    icon: FileCode2,
    title: "Markdown is the source of truth.",
    body: "Soul, skills, routines — readable, diffable, committable. The database is the index, not the truth.",
  },
  {
    icon: GitBranch,
    title: "Scheduled, not chatty.",
    body: "Routines on a cron beat another Slack bot. Kick off work at 7am; review what shipped at 9.",
  },
  {
    icon: Server,
    title: "Your server, your keys.",
    body: "SQLite on a laptop, Postgres in prod, and the model credentials you already pay for. No vendor lock.",
  },
];

export function Principles() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Opinions we ship with.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          The defaults matter. Here are ours.
        </p>
      </div>
      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        {PRINCIPLES.map((p) => {
          const Icon = p.icon;
          return (
            <div
              key={p.title}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.body}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
