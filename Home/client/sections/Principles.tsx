import { BellOff, Database, FileCode2, Server, type LucideIcon } from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type Principle = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const PRINCIPLES: Principle[] = [
  {
    icon: Database,
    title: "One database, one source of truth",
    body: "Souls, skills, routines, and run logs all live in one database. Back it up, restore it, migrate without losing a line.",
  },
  {
    icon: BellOff,
    title: "Scheduled, not chatty",
    body: "Routines on a cron beat another bot in another channel. Quiet until something needs you.",
  },
  {
    icon: Server,
    title: "Your server, your keys",
    body: "SQLite on a laptop, Postgres in prod, and the model credentials you already pay for. No vendor lock.",
  },
  {
    icon: FileCode2,
    title: "Markdown all the way down",
    body: "Every document an employee touches is plain text. If you can write in Notion, you can run an employee.",
  },
];

export function Principles() {
  return (
    <section id="house-rules" className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>Principles</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            The defaults we ship with.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            Genosyn is opinionated on purpose. Four calls we made early and
            kept through every refactor.
          </p>
        </div>

        <ol className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-5 sm:grid-cols-2">
          {PRINCIPLES.map((p, i) => (
            <li
              key={p.title}
              className="group flex gap-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 transition group-hover:bg-zinc-200">
                <p.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                    #{String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-1 text-base font-semibold text-zinc-950">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">{p.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
