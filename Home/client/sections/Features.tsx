import { Cpu, Database, GitBranch, KeyRound, Lock, Server, Users, Zap } from "lucide-react";
import { type LucideIcon } from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: Users,
    title: "A roster, not a single agent",
    body: "Hire as many AI employees as you need. Each has their own credentials, working directory, and audit trail.",
  },
  {
    icon: Cpu,
    title: "Bring your own brain",
    body: "Plug in claude-code, codex, opencode, or goose per employee. Costs land on the provider's invoice, not ours.",
  },
  {
    icon: Database,
    title: "SQLite today, Postgres tomorrow",
    body: "One config file, one process, one database. Flip a flag when you outgrow SQLite. No data migration scripts.",
  },
  {
    icon: Lock,
    title: "Self-hosted, always",
    body: "Runs on your infrastructure. Your keys, your data, your control. No vendor lock-in, no telemetry phone-home.",
  },
  {
    icon: GitBranch,
    title: "Markdown all the way down",
    body: "Souls, skills, routines — every document is plain text you can grep, diff, and version in git.",
  },
  {
    icon: Zap,
    title: "Boots in 200ms",
    body: "Single Node process. SQLite under the hood. No queue, no broker, no Kubernetes cluster on day one.",
  },
];

export function Features() {
  return (
    <section id="platform" className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>The platform</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            Opinionated where it matters,{" "}
            <span className="text-zinc-500">flexible where you need it.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            One runtime for a whole company. The defaults get you running in a
            minute, the escape hatches are there when you grow.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className="group rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200 transition group-hover:bg-zinc-200">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-zinc-950">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{f.body}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 grid grid-cols-2 gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/60 p-3 sm:grid-cols-4">
          <Stat icon={Database} label="Database" value="SQLite → PG" />
          <Stat icon={Server} label="Runtime" value="One container" />
          <Stat icon={KeyRound} label="Auth" value="No JWT" />
          <Stat icon={GitBranch} label="License" value="MIT" />
        </div>
      </div>
    </section>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 ring-1 ring-zinc-100">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-700">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </div>
        <div className="truncate text-sm font-medium text-zinc-950">{value}</div>
      </div>
    </div>
  );
}
