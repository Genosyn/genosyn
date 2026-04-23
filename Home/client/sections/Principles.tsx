import { BellOff, FileCode2, Server, type LucideIcon } from "lucide-react";

type Principle = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const PRINCIPLES: Principle[] = [
  {
    icon: FileCode2,
    title: "One database, one source of truth.",
    body: "Souls, skills, routines, and run logs all live in one database. Back it up, restore it, migrate SQLite → Postgres without losing a line.",
  },
  {
    icon: BellOff,
    title: "Scheduled, not chatty.",
    body: "Routines on a cron beat another Slack bot. Kick off work at 7am; review what shipped at 9. Quiet until something needs you.",
  },
  {
    icon: Server,
    title: "Your server, your keys.",
    body: "SQLite on a laptop, Postgres in prod, and the model credentials you already pay for. No vendor lock, no usage metering.",
  },
];

export function Principles() {
  return (
    <section id="principles" className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
      <div className="mx-auto max-w-2xl text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          Principles
        </div>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          The defaults we ship with.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          Genosyn is opinionated on purpose. These are the three we won&rsquo;t budge on.
        </p>
      </div>
      <ol className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        {PRINCIPLES.map((p, i) => {
          const Icon = p.icon;
          return (
            <li
              key={p.title}
              className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
            >
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                #{String(i + 1).padStart(2, "0")}
              </span>
              <div className="mt-4 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-slate-900">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.body}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
