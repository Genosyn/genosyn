import { type ReactNode } from "react";
import { BookHeart, CalendarClock, FileText, Sparkles } from "lucide-react";

export function Primitives() {
  return (
    <section id="primitives" className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <SectionEyebrow>The building blocks</SectionEyebrow>
        <h2 className="mt-4 max-w-3xl text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
          Three things every employee needs.{" "}
          <span className="text-zinc-500">All of them, in markdown.</span>
        </h2>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-zinc-600">
          Soul says who they are. Skills describe what they know. Routines are
          when they work. The whole employee fits in three editable text
          fields you can read, diff, and own.
        </p>

        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card
            icon={<BookHeart className="h-5 w-5" />}
            tag="Soul"
            title="A constitution, not a prompt"
            body="One markdown document that describes how the employee thinks, what they value, and what they refuse. Edit it like a job description."
          >
            <SoulPreview />
          </Card>

          <Card
            icon={<Sparkles className="h-5 w-5" />}
            tag="Skills"
            title="Reusable playbooks"
            body="Each skill is a named markdown file. Compose them across your team, version them in git, and share them between employees."
          >
            <SkillsPreview />
          </Card>

          <Card
            icon={<CalendarClock className="h-5 w-5" />}
            tag="Routines"
            title="Work, on a schedule"
            body="Pair a brief with a cron expression. Genosyn runs it on time, captures the output, and saves it as a Run you can read line by line."
          >
            <RoutinesPreview />
          </Card>
        </div>
      </div>
    </section>
  );
}

export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-600 shadow-card">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-900" />
      {children}
    </div>
  );
}

function Card({
  icon,
  tag,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  tag: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift">
      <div className="flex items-center gap-3 px-6 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200">
          {icon}
        </div>
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {tag}
        </span>
      </div>
      <div className="px-6 pt-4">
        <h3 className="text-xl font-semibold text-zinc-950">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
      </div>
      <div className="mt-6 px-6 pb-6">{children}</div>
    </article>
  );
}

function SoulPreview() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 font-mono text-[12px] leading-6 text-zinc-700">
      <div className="flex items-center gap-1.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
        <FileText className="h-3 w-3" />
        soul.md
      </div>
      <div className="text-zinc-950"># Alex Brand</div>
      <div className="text-zinc-500">Senior brand writer.</div>
      <div className="mt-2 font-semibold text-zinc-950">## Voice</div>
      <div>- Concrete over clever.</div>
      <div>- Shorter is braver.</div>
      <div className="mt-2 font-semibold text-zinc-950">## Never</div>
      <div>- Promise features that haven&apos;t shipped.</div>
    </div>
  );
}

function SkillsPreview() {
  const skills = [
    { name: "write-weekly-digest", tag: "writing", color: "bg-sky-50 text-sky-700 ring-sky-200" },
    { name: "triage-inbox", tag: "ops", color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
    { name: "reconcile-stripe", tag: "finance", color: "bg-amber-50 text-amber-700 ring-amber-200" },
    { name: "page-oncall", tag: "ops", color: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  ];
  return (
    <div className="space-y-2">
      {skills.map((s) => (
        <div
          key={s.name}
          className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
            <span className="truncate font-mono text-[12px] text-zinc-700">
              {s.name}
            </span>
          </div>
          <span className={`ml-2 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${s.color}`}>
            {s.tag}
          </span>
        </div>
      ))}
    </div>
  );
}

function RoutinesPreview() {
  const routines = [
    { name: "Morning brief", cron: "30 8 * * 1-5", state: "running" as const },
    { name: "Reconcile Stripe", cron: "0 7 * * *", state: "scheduled" as const },
    { name: "Weekly digest", cron: "0 17 * * 5", state: "scheduled" as const },
  ];
  const styles: Record<string, string> = {
    running: "bg-amber-50 text-amber-700 ring-amber-200",
    scheduled: "bg-zinc-100 text-zinc-600 ring-zinc-200",
  };
  return (
    <div className="space-y-2">
      {routines.map((r) => (
        <div
          key={r.name}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
              <span className="truncate text-sm font-medium text-zinc-800">
                {r.name}
              </span>
            </div>
            <span
              className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${styles[r.state]}`}
            >
              {r.state}
            </span>
          </div>
          <div className="mt-1 pl-5 font-mono text-[11px] text-zinc-500">
            {r.cron}
          </div>
        </div>
      ))}
    </div>
  );
}
