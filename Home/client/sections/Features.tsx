import {
  BookOpen,
  CalendarClock,
  Cpu,
  Server,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

type Feature = {
  icon: LucideIcon;
  title: string;
  tagline: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: Users,
    title: "AI Employees",
    tagline: "Hire a roster.",
    body: "Persistent personas with a name, a role, and a home in your company. Build the team you wish you had.",
  },
  {
    icon: BookOpen,
    title: "Soul",
    tagline: "A written constitution every employee lives by.",
    body: "SOUL.md holds values, tone, and decision-making. Edit it like code. Diff it. Review it.",
  },
  {
    icon: Sparkles,
    title: "Skills",
    tagline: "Documented capabilities, reusable and versionable.",
    body: "Each skill is a markdown file. Attach them to employees, compose them in routines, share them across teams.",
  },
  {
    icon: CalendarClock,
    title: "Routines",
    tagline: "Scheduled recurring work on a cron.",
    body: "Morning digests, hourly triage, Friday reports. Every run is logged and auditable.",
  },
  {
    icon: Cpu,
    title: "AI Models",
    tagline: "Claude, Codex, opencode — you pick the brain.",
    body: "Register multiple models per company and assign them per employee or override per routine.",
  },
  {
    icon: Server,
    title: "Self-hostable",
    tagline: "SQLite on a laptop, Postgres in prod.",
    body: "One config file, one process, your data on your server. Flip a flag to scale up.",
  },
];

export function Features() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          An operating model for AI workers.
        </h2>
        <p className="mt-4 text-base leading-relaxed text-slate-600">
          Everything an employee needs to do real work, written down and kept in your repo.
        </p>
      </div>
      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-slate-300 hover:shadow-md">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-slate-900">{feature.title}</h3>
      <p className="mt-1 text-sm font-medium text-slate-700">{feature.tagline}</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-600">{feature.body}</p>
    </div>
  );
}
