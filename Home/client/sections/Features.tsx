import {
  ArrowRight,
  Database,
  FileText,
  GitBranch,
  Globe,
  Hash,
  KeyRound,
  LayoutGrid,
  Library,
  ListTodo,
  MessageSquare,
  Mic,
  Plug,
  Server,
  StickyNote,
  Table2,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { SectionEyebrow } from "@/sections/Primitives";

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
  tags: string[];
  /** Tailwind classes for the icon tile. */
  accent: string;
  /** Grid span at the lg breakpoint. Defaults to 1. */
  span?: 1 | 2 | 3;
  /** Optional inline product preview rendered inside the card. */
  preview?: ReactNode;
};

type FeatureGroup = {
  label: string;
  blurb: string;
  features: Feature[];
};

const GROUPS: FeatureGroup[] = [
  {
    label: "Essentials",
    blurb:
      "Where humans and AI employees do the day's work — together, in one place.",
    features: [
      {
        icon: MessageSquare,
        title: "Workspace",
        body: "Channels, DMs, threads, and file uploads. @mention an employee and they show up like any other teammate.",
        tags: ["Channels", "DMs", "Files"],
        accent: "bg-indigo-50 text-indigo-700 ring-indigo-200",
        span: 2,
        preview: <WorkspacePreview />,
      },
      {
        icon: ListTodo,
        title: "Tasks",
        body: "Projects with a kanban board, statuses, assignees, due dates, and review queues. Routines drop work into the right column.",
        tags: ["Projects", "Kanban", "Reviews"],
        accent: "bg-rose-50 text-rose-700 ring-rose-200",
      },
    ],
  },
  {
    label: "Knowledge",
    blurb:
      "Your team's shared memory — read and written by humans and employees alike.",
    features: [
      {
        icon: Table2,
        title: "Bases",
        body: "Airtable-style multi-table workspaces with views, formulas, comments, and attachments. Your employees query and update rows alongside you.",
        tags: ["Tables", "Views", "Records"],
        accent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        span: 2,
        preview: <BasesPreview />,
      },
      {
        icon: StickyNote,
        title: "Notes",
        body: "Notion-style hierarchical markdown pages for SOPs, briefs, and research. Your employees can read every page.",
        tags: ["Pages", "Search", "Hierarchy"],
        accent: "bg-amber-50 text-amber-700 ring-amber-200",
      },
      {
        icon: Library,
        title: "Resources",
        body: "URLs, ebooks, transcripts, and reference docs your AI employees can study and cite. Drop a link once, the workspace remembers it forever.",
        tags: ["Links", "Ebooks", "Transcripts"],
        accent: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
        span: 3,
        preview: <ResourcesPreview />,
      },
    ],
  },
  {
    label: "Automation",
    blurb:
      "The deterministic glue work that doesn't need an LLM in the loop.",
    features: [
      {
        icon: Workflow,
        title: "Pipelines",
        body: "Visual DAG editor for triggers, branches, delays, and integration nodes. Schedule them on cron, fire them on events, or call them from a routine.",
        tags: ["Triggers", "Branches", "Nodes"],
        accent: "bg-violet-50 text-violet-700 ring-violet-200",
        span: 3,
        preview: <PipelinesPreview />,
      },
    ],
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
            already needs to actually run a company. Shipped on by default,
            and the same place your employees write to.
          </p>
        </div>

        <div className="mt-16 space-y-16 sm:space-y-20">
          {GROUPS.map((group) => (
            <FeatureGroupBlock key={group.label} group={group} />
          ))}
        </div>

        <div className="mt-20">
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

function FeatureGroupBlock({ group }: { group: FeatureGroup }) {
  return (
    <div>
      <div className="mb-7">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
            {group.label}
          </span>
          <span aria-hidden className="hidden h-px flex-1 bg-zinc-200/80 sm:block" />
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-600">
          {group.blurb}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {group.features.map((f) => (
          <FeatureCard key={f.title} feature={f} />
        ))}
      </div>
    </div>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const span = feature.span ?? 1;
  const spanClass =
    span === 3 ? "lg:col-span-3" : span === 2 ? "sm:col-span-2 lg:col-span-2" : "";

  return (
    <article
      className={`group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-lift ${spanClass}`}
    >
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition group-hover:scale-105 ${feature.accent}`}
      >
        <feature.icon className="h-5 w-5" />
      </div>
      <h3 className="mt-5 text-base font-semibold text-zinc-950">
        {feature.title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">
        {feature.body}
      </p>
      <ul className="mt-4 flex flex-wrap gap-1.5">
        {feature.tags.map((t) => (
          <li
            key={t}
            className="inline-flex items-center rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 ring-1 ring-zinc-200/70"
          >
            {t}
          </li>
        ))}
      </ul>
      {feature.preview && <div className="mt-6">{feature.preview}</div>}
    </article>
  );
}

// ────────────────────────── Inline product previews ──────────────────────────

function WorkspacePreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/60">
      <div className="flex items-center gap-2 border-b border-zinc-200/70 bg-white/70 px-4 py-2.5 text-[11px]">
        <Hash className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">marketing</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-400">3 online</span>
      </div>
      <div className="space-y-3.5 px-4 py-4">
        <ChatLine
          initials="SS"
          color="bg-emerald-100 text-emerald-700"
          name="Sam"
          time="9:12 AM"
          message="@Alex any update on the Friday digest?"
        />
        <ChatLine
          initials="AB"
          color="bg-sky-100 text-sky-700"
          name="Alex"
          time="9:13 AM"
          isAI
          message="Drafting now. Preview at 4 PM — I'll @ here when it's ready."
        />
      </div>
    </div>
  );
}

function ChatLine({
  initials,
  color,
  name,
  time,
  message,
  isAI,
}: {
  initials: string;
  color: string;
  name: string;
  time: string;
  message: string;
  isAI?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold ${color}`}
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-zinc-900">{name}</span>
          {isAI && (
            <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-violet-700 ring-1 ring-violet-200">
              AI
            </span>
          )}
          <span className="text-[11px] text-zinc-400">{time}</span>
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-700">
          {message}
        </div>
      </div>
    </div>
  );
}

function BasesPreview() {
  const rows: Array<{ customer: string; plan: string; mrr: string; tone: string }> = [
    { customer: "Acme Co.", plan: "Pro", mrr: "$290", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
    { customer: "Globex", plan: "Team", mrr: "$980", tone: "bg-violet-50 text-violet-700 ring-violet-200" },
    { customer: "Initech", plan: "Pro", mrr: "$290", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/60 px-3 py-2 text-[11px]">
        <Table2 className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">customers</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-400">grid view</span>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-500">
            <th className="px-3 py-2 text-left font-medium">Customer</th>
            <th className="px-3 py-2 text-left font-medium">Plan</th>
            <th className="px-3 py-2 text-right font-medium">MRR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 text-[12.5px]">
          {rows.map((r) => (
            <tr key={r.customer}>
              <td className="px-3 py-2 font-medium text-zinc-800">{r.customer}</td>
              <td className="px-3 py-2">
                <span
                  className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${r.tone}`}
                >
                  {r.plan}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-800">
                {r.mrr}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResourcesPreview() {
  const items: Array<{ icon: LucideIcon; label: string; kind: string; tone: string }> = [
    {
      icon: Globe,
      label: "stripe.com/docs/billing",
      kind: "URL",
      tone: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    {
      icon: Mic,
      label: "All-hands · Q1 retro",
      kind: "Transcript",
      tone: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    {
      icon: Video,
      label: "Onboarding walkthrough",
      kind: "Video",
      tone: "bg-rose-50 text-rose-700 ring-rose-200",
    },
    {
      icon: FileText,
      label: "Pricing one-pager.pdf",
      kind: "PDF",
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="flex flex-col rounded-xl border border-zinc-200 bg-white p-3"
        >
          <span
            className={`inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${it.tone}`}
          >
            <it.icon className="h-3 w-3" />
            {it.kind}
          </span>
          <div className="mt-2.5 truncate text-[12.5px] font-medium text-zinc-800">
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function PipelinesPreview() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
      <div className="flex items-center gap-2 pb-3 text-[11px]">
        <Workflow className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">stripe-large-charge.flow</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Live
        </span>
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto sm:gap-3">
        <PipelineNode
          icon={Plug}
          title="Stripe webhook"
          subtitle="Trigger"
          tone="bg-amber-50 text-amber-700 ring-amber-200"
        />
        <PipelineConnector />
        <PipelineNode
          icon={GitBranch}
          title="If amount > $1000"
          subtitle="Branch"
          tone="bg-violet-50 text-violet-700 ring-violet-200"
        />
        <PipelineConnector />
        <PipelineNode
          icon={MessageSquare}
          title="Post to #wins"
          subtitle="Slack"
          tone="bg-indigo-50 text-indigo-700 ring-indigo-200"
        />
      </div>
    </div>
  );
}

function PipelineNode({
  icon: Icon,
  title,
  subtitle,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  tone: string;
}) {
  return (
    <div className="flex min-w-[140px] flex-1 flex-col rounded-xl border border-zinc-200 bg-white px-3 py-2.5 shadow-card">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${tone}`}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {subtitle}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-medium text-zinc-800">
        {title}
      </div>
    </div>
  );
}

function PipelineConnector() {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center self-center text-zinc-300"
    >
      <ArrowRight className="h-4 w-4" />
    </div>
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
