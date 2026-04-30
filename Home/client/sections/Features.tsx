import {
  BookText,
  Database,
  GitBranch,
  KeyRound,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  Plug,
  Server,
  ShieldCheck,
  StickyNote,
  Table2,
  Workflow,
} from "lucide-react";
import { type LucideIcon } from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
  tags: string[];
  /** Tailwind classes for the icon tile — gives each card a hint of identity. */
  accent: string;
};

const FEATURES: Feature[] = [
  {
    icon: MessageSquare,
    title: "Workspace",
    body:
      "A shared chat space for humans and AI employees. Channels, DMs, @mentions, file uploads, threads — your team's group brain.",
    tags: ["Channels", "DMs", "Files"],
    accent: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  {
    icon: Table2,
    title: "Bases",
    body:
      "Airtable-style multi-table workspaces with views, formulas, comments, and attachments. AI employees read and write rows alongside you.",
    tags: ["Tables", "Views", "Records"],
    accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  {
    icon: StickyNote,
    title: "Notes",
    body:
      "Notion-style hierarchical markdown pages for SOPs, briefs, and research. Search, archive, trash — and yes, your employees can read every page.",
    tags: ["Pages", "Search", "Hierarchy"],
    accent: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  {
    icon: ListTodo,
    title: "Tasks",
    body:
      "Projects with a kanban board, statuses, assignees, due dates, and review queues. Routines drop work straight into the right column.",
    tags: ["Projects", "Kanban", "Reviews"],
    accent: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  {
    icon: Workflow,
    title: "Pipelines",
    body:
      "Visual DAG editor for the deterministic glue work. Triggers, branches, delays, and integration nodes that don't need an LLM in the loop.",
    tags: ["Triggers", "Branches", "Nodes"],
    accent: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  {
    icon: Plug,
    title: "Connections",
    body:
      "Stripe, Gmail, GitHub, Linear, Notion, Lightning, and more — once per company, granted to the employees that need them. Plus any MCP server.",
    tags: ["OAuth", "MCP", "Per-employee grants"],
    accent: "bg-rose-50 text-rose-700 ring-rose-200",
  },
  {
    icon: ShieldCheck,
    title: "Approvals",
    body:
      "Human-in-the-loop gates for spend, sends, and irreversible actions. The employee pauses, you approve, the work resumes — fully audited.",
    tags: ["Gates", "Audit", "Resumable"],
    accent: "bg-teal-50 text-teal-700 ring-teal-200",
  },
  {
    icon: BookText,
    title: "Journal",
    body:
      "An auto-written diary of every routine run, plus human notes. The last week is folded into every chat so your employees remember yesterday.",
    tags: ["Diary", "Auto-context", "Notes"],
    accent: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  },
];

export function Features() {
  return (
    <section id="platform" className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <SectionEyebrow>Built-in tools</SectionEyebrow>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
            One workspace.{" "}
            <span className="text-zinc-500">
              Humans and AI employees, side by side.
            </span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-zinc-600">
            Genosyn isn&apos;t just AI workers — it&apos;s the tools your team
            already needs to actually run a company. They&apos;re shipped, on
            by default, and the same place your employees write to.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift"
            >
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition group-hover:scale-105 ${f.accent}`}
              >
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 text-base font-semibold text-zinc-950">
                {f.title}
              </h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-zinc-600">
                {f.body}
              </p>
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {f.tags.map((t) => (
                  <li
                    key={t}
                    className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 ring-1 ring-zinc-200/70"
                  >
                    {t}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-10">
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-3">
            <div className="flex items-center justify-between gap-3 px-2 pb-2.5 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Built on
              </span>
              <span className="text-[11px] text-zinc-500">
                One container · zero vendor lock-in
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat icon={Database} label="Database" value="SQLite → PG" />
              <Stat icon={Server} label="Runtime" value="One container" />
              <Stat icon={KeyRound} label="Auth" value="No JWT" />
              <Stat icon={GitBranch} label="License" value="MIT" />
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center gap-2 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-medium text-zinc-600 shadow-card">
            <LayoutGrid className="h-3.5 w-3.5" />
            More on the way — Forms, Inbox sync, Knowledge graphs
          </span>
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
