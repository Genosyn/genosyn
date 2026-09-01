import type { ReactNode } from "react";
import {
  ArrowRight,
  Bell,
  BookHeart,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Hash,
  Landmark,
  Library,
  Mail,
  MessageSquare,
  Mic,
  Paperclip,
  Search,
  Sparkles,
  Star,
  StickyNote,
  Table2,
  Terminal,
  TrendingUp,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react";

/**
 * Hero mockups for each product page — a stylized, static rendering of the
 * real product UI, framed in the same window chrome the home hero uses.
 * Resolved by slug via productPreview().
 */

const PREVIEWS: Record<string, () => JSX.Element> = {
  "ai-employees": EmployeesPreview,
  workspace: WorkspacePreview,
  tasks: TasksPreview,
  bases: BasesPreview,
  notes: NotesPreview,
  resources: ResourcesPreview,
  pipelines: PipelinesPreview,
  explore: ExplorePreview,
  marketing: MarketingPreview,
  revenue: RevenuePreview,
  email: EmailPreview,
  customers: CustomersPreview,
  finance: FinancePreview,
  code: CodePreview,
};

export function productPreview(slug: string): (() => JSX.Element) | undefined {
  return PREVIEWS[slug];
}

// ─────────────────────────────── shared chrome ──────────────────────────────

function Window({ url, children }: { url: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden bg-white">
      <div className="flex h-11 items-center gap-2 border-b border-zinc-200 bg-white px-3 text-zinc-800">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="h-4 w-4 rounded-full border-[1.5px] border-zinc-900" />
          <span className="hidden text-[9px] font-bold tracking-[0.2em] text-zinc-950 sm:inline">
            GENOSYN
          </span>
        </div>
        <span className="h-4 w-px shrink-0 bg-zinc-200" />
        <div className="inline-flex min-w-0 items-center gap-1 px-1.5 py-1 text-[10px] font-semibold text-zinc-900">
          <span className="truncate">Northstar Labs</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-600" />
        </div>
        <span className="hidden text-zinc-600 sm:inline">/</span>
        <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
          <span className="h-4 w-4 rounded bg-zinc-200 text-center text-[9px] font-bold leading-4 text-zinc-900">
            G
          </span>
          <span className="max-w-48 truncate text-[10px] font-medium text-zinc-800">
            {url.replace("genosyn.com / ", "")}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="hidden rounded border border-zinc-200 bg-paper-100 px-1.5 py-0.5 text-[8px] font-medium text-zinc-600 sm:inline">
            ⌘ K
          </span>
          <span className="flex h-6 w-6 items-center justify-center text-zinc-600">
            <Bell className="h-3 w-3" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-950 text-[8px] font-semibold text-white">
            ND
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}

function Tag({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${tone}`}
    >
      {children}
    </span>
  );
}

function Avatar({ initials, color }: { initials: string; color: string }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center text-[10px] font-semibold ${color}`}
    >
      {initials}
    </span>
  );
}

// ─────────────────────────────── AI Employees ───────────────────────────────

function EmployeesPreview() {
  return (
    <Window url="genosyn.com / mira — bookkeeper">
      <div className="grid grid-cols-1 gap-0 md:grid-cols-5">
        <div className="border-b border-zinc-100 p-5 md:col-span-2 md:border-b-0 md:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center bg-paper-200 text-sm font-semibold text-zinc-800">
              MF
            </span>
            <div>
              <div className="text-sm font-semibold text-zinc-950">Mira</div>
              <div className="text-xs text-zinc-600">Bookkeeper · AI Employee</div>
            </div>
            <span className="ml-auto inline-flex items-center gap-1 bg-signal-500 px-2 py-0.5 text-[10px] font-semibold text-zinc-950 ring-1 ring-signal-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-500" />
              Running
            </span>
          </div>
          <div className="mt-4 border border-zinc-200 bg-paper-100/60 p-3.5 font-mono text-[11.5px] leading-5 text-zinc-800">
            <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              <BookHeart className="h-3 w-3" />
              Soul
            </div>
            <div className="text-zinc-950"># Mira</div>
            <div className="text-zinc-600">Careful, exact, allergic to drift.</div>
            <div className="mt-1.5 font-semibold text-zinc-950">## Never</div>
            <div>- Post an unbalanced entry.</div>
            <div>- Guess an exchange rate.</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["reconcile-stripe", "close-the-month", "chase-overdue"].map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 bg-paper-200 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-800 ring-1 ring-zinc-900/[0.08]"
              >
                <Sparkles className="h-2.5 w-2.5" />
                {s}
              </span>
            ))}
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2 text-[11px]">
            <CalendarClock className="h-3.5 w-3.5 text-zinc-600" />
            <span className="font-medium text-zinc-800">Reconcile Stripe</span>
            <span className="font-mono text-[10px] text-zinc-600">0 7 * * *</span>
            <span className="ml-auto font-mono text-[10px] text-zinc-600">Run #212 · live</span>
          </div>
          <div className="mt-3 space-y-1.5 border border-night-700 bg-night-950 p-4 font-mono text-[11px] leading-5 text-zinc-300">
            <div>
              <span className="text-zinc-400">[07:00:02]</span> stripe_list_charges — 42 since
              yesterday
            </div>
            <div>
              <span className="text-zinc-400">[07:00:19]</span> matched 41 to open invoices
            </div>
            <div>
              <span className="text-zinc-400">[07:00:24]</span> posting DR Bank / CR Accounts
              Receivable
            </div>
            <div>
              <span className="text-zinc-400">[07:00:31]</span>{" "}
              <span className="text-paper-50">✓</span> ledger balanced — 1 charge flagged for
              review
            </div>
            <div>
              <span className="text-zinc-400">[07:00:33]</span> send_workspace_message → #finance
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-600">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-zinc-800" />
              211 successful runs · transcript kept for every one
            </span>
            <span className="font-mono text-[10px]">claude · active model</span>
          </div>
        </div>
      </div>
    </Window>
  );
}

// ──────────────────────────────── Workspace ─────────────────────────────────

function WorkspacePreview() {
  return (
    <Window url="genosyn.com / workspace / #marketing">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 text-[11px]">
        <Hash className="h-3.5 w-3.5 text-zinc-600" />
        <span className="font-medium text-zinc-800">marketing</span>
        <span className="text-zinc-600">· Launch week comms</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">4 online</span>
      </div>
      <div className="space-y-4 px-5 py-5">
        <ChatLine
          initials="ND"
          color="bg-zinc-950 text-white"
          name="Nawaz"
          time="9:12 AM"
          message={
            <>@Alex the launch brief is attached — can you turn it into the Friday digest?</>
          }
          attachment="launch-brief.pdf"
        />
        <ChatLine
          initials="AB"
          color="bg-paper-200 text-zinc-800"
          name="Alex"
          time="9:13 AM"
          isAI
          message={
            <>
              Read it. Draft coming to <span className="font-medium">#marketing</span> by 4 PM —
              pricing section needs one number from @Mira, pinged her in a DM.
            </>
          }
          reaction="👍 2"
        />
        <div className="flex items-center gap-2 pl-9 text-[11px] text-zinc-600">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-paper-100 px-2.5 py-1">
            <span className="flex gap-0.5">
              <span className="h-1 w-1 animate-pulse rounded-full bg-white/40" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-white/40 [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-white/40 [animation-delay:300ms]" />
            </span>
            Mira is typing…
          </span>
        </div>
      </div>
    </Window>
  );
}

function ChatLine({
  initials,
  color,
  name,
  time,
  message,
  isAI,
  attachment,
  reaction,
}: {
  initials: string;
  color: string;
  name: string;
  time: string;
  message: ReactNode;
  isAI?: boolean;
  attachment?: string;
  reaction?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Avatar initials={initials} color={color} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-zinc-950">{name}</span>
          {isAI && (
            <span className="bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-zinc-900 ring-1 ring-zinc-300">
              AI
            </span>
          )}
          <span className="text-[11px] text-zinc-600">{time}</span>
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-800">{message}</div>
        {attachment && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 border border-zinc-200 bg-paper-100 px-2.5 py-1.5 text-[11px] font-medium text-zinc-700">
            <Paperclip className="h-3 w-3" />
            {attachment}
          </div>
        )}
        {reaction && (
          <div className="mt-1.5 inline-flex items-center rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] text-zinc-800">
            {reaction}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────── Tasks ───────────────────────────────────

function TasksPreview() {
  const cols: Array<{
    label: string;
    count: number;
    cards: Array<{
      id: string;
      title: string;
      who: string;
      color: string;
      isAI?: boolean;
      review?: boolean;
    }>;
  }> = [
    {
      label: "In progress",
      count: 3,
      cards: [
        {
          id: "ENG-42",
          title: "Ship pricing page A/B test",
          who: "SS",
          color: "bg-paper-200 text-zinc-800",
        },
        {
          id: "MKT-7",
          title: "Draft Friday digest",
          who: "AB",
          color: "bg-paper-200 text-zinc-800",
          isAI: true,
        },
      ],
    },
    {
      label: "In review",
      count: 2,
      cards: [
        {
          id: "FIN-19",
          title: "March close checklist",
          who: "MF",
          color: "bg-signal-500 text-zinc-950",
          isAI: true,
          review: true,
        },
        {
          id: "ENG-38",
          title: "Rotate webhook secrets",
          who: "SS",
          color: "bg-paper-200 text-zinc-800",
          review: true,
        },
      ],
    },
    {
      label: "Done",
      count: 14,
      cards: [
        {
          id: "MKT-5",
          title: "Q2 newsletter calendar",
          who: "AB",
          color: "bg-paper-200 text-zinc-800",
          isAI: true,
        },
      ],
    },
  ];
  return (
    <Window url="genosyn.com / tasks / launch-week — board">
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
        {cols.map((col) => (
          <div key={col.label} className="bg-paper-100/70 p-2.5 ring-1 ring-zinc-900/[0.06]">
            <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              {col.label}
              <span className="font-mono text-zinc-600">{col.count}</span>
            </div>
            <div className="space-y-2">
              {col.cards.map((card) => (
                <div
                  key={card.id}
                  className="border border-zinc-200 bg-white p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-medium text-zinc-600">
                      {card.id}
                    </span>
                    {card.review && (
                      <Tag tone="bg-signal-500 text-zinc-950 ring-signal-600">awaiting review</Tag>
                    )}
                  </div>
                  <div className="mt-1 text-[12.5px] font-medium leading-snug text-zinc-900">
                    {card.title}
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span
                      className={`flex h-5 w-5 items-center justify-center text-[8px] font-semibold ${card.color}`}
                    >
                      {card.who}
                    </span>
                    {card.isAI && (
                      <span className="bg-zinc-100 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-zinc-900 ring-1 ring-zinc-300">
                        AI
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Window>
  );
}

// ────────────────────────────────── Bases ───────────────────────────────────

function BasesPreview() {
  const rows: Array<{
    name: string;
    stage: string;
    tone: string;
    owner: string;
    ownerColor: string;
    acv: string;
  }> = [
    {
      name: "Acme Co.",
      stage: "Won",
      tone: "bg-paper-200 text-zinc-800 ring-paper-400",
      owner: "SS",
      ownerColor: "bg-paper-200 text-zinc-800",
      acv: "$14,400",
    },
    {
      name: "Globex",
      stage: "Proposal",
      tone: "bg-zinc-100 text-zinc-900 ring-zinc-300",
      owner: "AB",
      ownerColor: "bg-paper-200 text-zinc-800",
      acv: "$32,000",
    },
    {
      name: "Initech",
      stage: "Discovery",
      tone: "bg-signal-500 text-zinc-950 ring-signal-600",
      owner: "SS",
      ownerColor: "bg-paper-200 text-zinc-800",
      acv: "$9,600",
    },
    {
      name: "Umbrella",
      stage: "Won",
      tone: "bg-paper-200 text-zinc-800 ring-paper-400",
      owner: "AB",
      ownerColor: "bg-paper-200 text-zinc-800",
      acv: "$21,000",
    },
  ];
  return (
    <Window url="genosyn.com / bases / sales-crm">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 text-[11px]">
        <Table2 className="h-3.5 w-3.5 text-zinc-600" />
        <span className="font-medium text-zinc-800">Deals</span>
        <span className="bg-paper-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
          view: Pipeline
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
          filtered · sorted by ACV
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px]">
          <thead>
            <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-600">
              <th className="px-5 py-2 text-left font-medium">Company</th>
              <th className="px-3 py-2 text-left font-medium">Stage</th>
              <th className="px-3 py-2 text-left font-medium">Owner</th>
              <th className="px-5 py-2 text-right font-medium">ACV</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 text-[12.5px]">
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="px-5 py-2.5 font-medium text-zinc-900">{r.name}</td>
                <td className="px-3 py-2.5">
                  <Tag tone={r.tone}>{r.stage}</Tag>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`flex h-5 w-5 items-center justify-center text-[8px] font-semibold ${r.ownerColor}`}
                  >
                    {r.owner}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-zinc-900">{r.acv}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-paper-100/60 px-5 py-2.5 text-[11px] text-zinc-600">
        <Sparkles className="h-3.5 w-3.5 text-zinc-800" />
        <span>
          <span className="font-medium text-zinc-800">Alex (AI)</span> updated 3 rows from
          yesterday&apos;s calls · audit-logged
        </span>
      </div>
    </Window>
  );
}

// ────────────────────────────────── Notes ───────────────────────────────────

function NotesPreview() {
  return (
    <Window url="genosyn.com / notes / ops / incident-runbook">
      <div className="grid grid-cols-1 md:grid-cols-3">
        <div className="border-b border-zinc-100 p-4 md:border-b-0 md:border-r">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            Ops notebook
          </div>
          <ul className="mt-2 space-y-1 text-[12px] text-zinc-700">
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-zinc-600" />
              Onboarding SOP
            </li>
            <li className="flex items-center gap-1.5 bg-paper-200 px-1.5 py-1 font-medium text-zinc-950">
              <StickyNote className="h-3 w-3 text-zinc-600" />
              Incident runbook
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-zinc-600" />
              Sev-1 checklist
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-zinc-600" />
              Postmortem template
            </li>
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-zinc-600" />
              Vendor contacts
            </li>
          </ul>
        </div>
        <div className="p-5 md:col-span-2">
          <div className="text-lg font-semibold text-zinc-950">🚨 Incident runbook</div>
          <div className="mt-1 text-[11px] text-zinc-600">
            Last edited by <span className="font-medium text-zinc-700">Sam (AI)</span> · 2 hours
            ago · audit-logged
          </div>
          <div className="mt-4 space-y-2.5 text-[12.5px] leading-relaxed text-zinc-800">
            <div className="font-semibold text-zinc-950">## First five minutes</div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center rounded border border-zinc-300 bg-white">
                <CheckCircle2 className="h-3 w-3 text-zinc-800" />
              </span>
              Page the on-call — Sam watches p99 every 15 min
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded border border-zinc-300 bg-white" />
              Open a #incident channel and pin the timeline
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded border border-zinc-300 bg-white" />
              Snapshot dashboards before restarting anything
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}

// ──────────────────────────────── Resources ─────────────────────────────────

function ResourcesPreview() {
  const items: Array<{
    icon: typeof Globe;
    label: string;
    kind: string;
    tone: string;
    meta: string;
  }> = [
    {
      icon: Globe,
      label: "stripe.com/docs/billing",
      kind: "URL",
      tone: "bg-paper-200 text-zinc-800 ring-paper-400",
      meta: "extracted · 41k chars",
    },
    {
      icon: FileText,
      label: "SOC 2 readiness guide.pdf",
      kind: "PDF",
      tone: "bg-paper-200 text-zinc-800 ring-paper-400",
      meta: "18 pages",
    },
    {
      icon: Library,
      label: "The Mom Test",
      kind: "EPUB",
      tone: "bg-paper-200 text-zinc-800 ring-paper-400",
      meta: "12 chapters",
    },
    {
      icon: Mic,
      label: "All-hands · Q1 retro",
      kind: "Transcript",
      tone: "bg-signal-500 text-zinc-950 ring-signal-600",
      meta: "48 min",
    },
  ];
  return (
    <Window url="genosyn.com / resources">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-3">
        <div className="flex flex-1 items-center gap-2 border border-zinc-200 bg-paper-100/60 px-3 py-1.5 text-[12px] text-zinc-600">
          <Search className="h-3.5 w-3.5" />
          usage-based billing
        </div>
        <span className="font-mono text-[10px] text-zinc-600">2 matches</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
        {items.map((it) => (
          <div
            key={it.label}
            className="flex flex-col border border-zinc-200 bg-white p-3"
          >
            <Tag tone={it.tone}>
              <it.icon className="h-3 w-3" />
              {it.kind}
            </Tag>
            <div className="mt-2.5 truncate text-[12.5px] font-medium text-zinc-900">
              {it.label}
            </div>
            <div className="mt-1 text-[10px] text-zinc-600">{it.meta}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-paper-100/60 px-5 py-2.5 text-[11px] text-zinc-600">
        <Sparkles className="h-3.5 w-3.5 text-zinc-800" />
        <span>
          <span className="font-medium text-zinc-800">Alex (AI)</span> cited the Stripe docs in
          today&apos;s pricing brief — every employee holds a read Grant
        </span>
      </div>
    </Window>
  );
}

// ──────────────────────────────── Pipelines ─────────────────────────────────

function PipelinesPreview() {
  return (
    <Window url="genosyn.com / pipelines / stripe-large-charge">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 text-[11px]">
        <Workflow className="h-3.5 w-3.5 text-zinc-600" />
        <span className="font-medium text-zinc-800">stripe-large-charge</span>
        <Tag tone="bg-paper-200 text-zinc-800 ring-paper-400">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-950" />
          Live
        </Tag>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          run #88 · completed in 1.2s
        </span>
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto p-5 sm:gap-3">
        <PipelineNode
          icon={Webhook}
          title="Stripe webhook"
          subtitle="Trigger"
          tone="bg-signal-500 text-zinc-950 ring-signal-600"
        />
        <PipelineConnector />
        <PipelineNode
          icon={GitBranch}
          title="amount &gt; $1,000"
          subtitle="Branch"
          tone="bg-zinc-100 text-zinc-900 ring-zinc-300"
        />
        <PipelineConnector />
        <PipelineNode
          icon={Sparkles}
          title="Ask Alex to summarize"
          subtitle="AI Employee"
          tone="bg-paper-200 text-zinc-800 ring-paper-400"
        />
        <PipelineConnector />
        <PipelineNode
          icon={MessageSquare}
          title="Post to #wins"
          subtitle="Message"
          tone="bg-paper-200 text-zinc-900 ring-zinc-900/[0.12]"
        />
      </div>
      <div className="border-t border-zinc-100 bg-paper-100/60 px-5 py-2.5 font-mono text-[10.5px] text-zinc-600">
        {"{{trigger.body.amount}}"} → $4,200 · branch: true · reply captured →{" "}
        {"{{ask-alex.reply}}"}
      </div>
    </Window>
  );
}

function PipelineNode({
  icon: Icon,
  title,
  subtitle,
  tone,
}: {
  icon: typeof Webhook;
  title: ReactNode;
  subtitle: string;
  tone: string;
}) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center ring-1 ${tone}`}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          {subtitle}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-medium text-zinc-900">{title}</div>
    </div>
  );
}

function PipelineConnector() {
  return (
    <div aria-hidden className="flex shrink-0 items-center self-center text-zinc-300">
      <ArrowRight className="h-4 w-4" />
    </div>
  );
}

// ───────────────────────────────── Explore ──────────────────────────────────

function MarketingPreview() {
  const rows = [
    { name: "Brand — Search", spend: "$212.40", pace: "98%", ok: true },
    { name: "Retargeting — Meta", spend: "$164.02", pace: "104%", ok: true },
    { name: "Prospecting — PMax", spend: "$489.77", pace: "173%", ok: false },
  ];
  return (
    <Window url="genosyn.com / approvals">
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-5">
        <div className="border border-zinc-200 bg-white p-4 sm:col-span-3">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-zinc-800">
              Daily pacing check · last 7 days
            </div>
            <span className="font-mono text-[10px] text-zinc-600">
              google-ads + meta-ads · Reese (AI)
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {rows.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between border border-zinc-100 px-3 py-2"
              >
                <span className="text-[11px] font-medium text-zinc-900">{r.name}</span>
                <span className="font-mono text-[10px] tabular-nums text-zinc-600">{r.spend}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[9px] ${
                    r.ok ? "bg-paper-200 text-zinc-800" : "bg-paper-200 text-zinc-800"
                  }`}
                >
                  {r.pace} pace
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 bg-night-950 p-3 font-mono text-[10px] leading-4 text-zinc-400">
            <div className="text-zinc-400">-- journal · 09:02</div>
            <div>
              Prospecting — PMax pacing 173% → <span className="text-signal-500">paused</span> (never
              gated). Proposal filed for review.
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <div className="border border-signal-600 bg-signal-500/15 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-950">
              Approval pending
            </div>
            <div className="mt-1 text-[11px] font-medium text-zinc-950">
              Google Ads · budget increase · 45.00 USD
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-800">
              Brand — Search: 30.00 → 45.00/day. CPA $18 vs $25 target.
            </div>
            <div className="mt-3 flex gap-2">
              <span className="bg-zinc-950 px-2.5 py-1 text-[10px] font-medium text-white">
                Approve
              </span>
              <span className="border border-zinc-300 bg-white px-2.5 py-1 text-[10px] font-medium text-zinc-800">
                Reject
              </span>
            </div>
          </div>
          <div className="flex-1 border border-zinc-200 bg-white p-4">
            <div className="text-[11px] font-semibold text-zinc-800">Connection caps</div>
            <div className="mt-2 flex flex-col gap-1.5 font-mono text-[10px] text-zinc-600">
              <div className="flex justify-between">
                <span>max single increase</span>
                <span className="text-zinc-900">$250</span>
              </div>
              <div className="flex justify-between">
                <span>daily increases</span>
                <span className="text-zinc-900">$120 / $500</span>
              </div>
              <div className="flex justify-between">
                <span>30-day increases</span>
                <span className="text-zinc-900">$980 / $5,000</span>
              </div>
              <div className="flex justify-between">
                <span>kill switch</span>
                <span className="text-zinc-800">off</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}

function ExplorePreview() {
  const bars = [34, 42, 38, 55, 61, 58, 72, 78];
  return (
    <Window url="genosyn.com / explore / dashboards / revenue">
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
        <div className="border border-zinc-200 bg-white p-4 sm:col-span-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-zinc-800">MRR by month</div>
            <span className="font-mono text-[10px] text-zinc-600">postgres · 8 rows</span>
          </div>
          <div className="mt-4 flex h-28 items-end gap-2">
            {bars.map((h, i) => (
              <div
                key={i}
                className={`flex-1 rounded-t-md ${i === bars.length - 1 ? "bg-zinc-950" : "bg-zinc-200"}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[9px] text-zinc-600">
            <span>Nov</span>
            <span>Jun</span>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="border border-zinc-200 bg-white p-4">
            <div className="text-[11px] font-semibold text-zinc-800">MRR</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-950">
              $48,220
            </div>
            <div className="mt-0.5 text-[10px] font-medium text-zinc-800">
              +8.4% vs last month
            </div>
          </div>
          <div className="flex-1 border border-night-700 bg-night-950 p-3.5 font-mono text-[10px] leading-4 text-zinc-400">
            <div className="text-zinc-400">-- saved chart · run by Mira (AI)</div>
            <div>
              <span className="text-zinc-300">select</span> month,{" "}
              <span className="text-zinc-300">sum</span>(mrr)
            </div>
            <div>
              <span className="text-zinc-300">from</span> subscriptions
            </div>
            <div>
              <span className="text-zinc-300">group by</span> 1{" "}
              <span className="text-zinc-300">order by</span> 1;
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}

// ───────────────────────────────── Revenue ──────────────────────────────────

const REVENUE_LOOP = ["ad click", "contact", "deal", "invoice", "collected cash", "ledger"];

function RevenuePreview() {
  const stages: Array<{
    label: string;
    count: number;
    deal: { name: string; amount: string; who: string; color: string; isAI?: boolean };
  }> = [
    {
      label: "Qualified",
      count: 6,
      deal: {
        name: "Initech",
        amount: "$9,600",
        who: "SS",
        color: "bg-paper-200 text-zinc-800",
      },
    },
    {
      label: "Demo",
      count: 4,
      deal: {
        name: "Umbrella",
        amount: "$21,000",
        who: "AB",
        color: "bg-paper-200 text-zinc-800",
        isAI: true,
      },
    },
    {
      label: "Proposal",
      count: 3,
      deal: {
        name: "Globex",
        amount: "$32,000",
        who: "AB",
        color: "bg-paper-200 text-zinc-800",
        isAI: true,
      },
    },
    {
      label: "Closed Won",
      count: 9,
      deal: {
        name: "Acme Co.",
        amount: "$14,400",
        who: "SS",
        color: "bg-paper-200 text-zinc-800",
      },
    },
  ];

  const timeline: Array<{
    icon: typeof Mail;
    tone: string;
    label: string;
    detail: string;
    time: string;
  }> = [
    {
      icon: Mail,
      tone: "bg-paper-200 text-zinc-700",
      label: "email in · Lee at Globex",
      detail: "matched to a known contact by mail sync",
      time: "9:12",
    },
    {
      icon: Zap,
      tone: "bg-signal-500 text-zinc-950",
      label: "signal · seats +4 on the trial",
      detail: "saved query on cron · fired once for this account",
      time: "9:14",
    },
    {
      icon: Sparkles,
      tone: "bg-zinc-100 text-zinc-900",
      label: "sequence step 2 · drafted by Alex (AI)",
      detail: "waiting in the review queue for a human Send",
      time: "9:15",
    },
    {
      icon: TrendingUp,
      tone: "bg-paper-200 text-zinc-800",
      label: "stage change · Demo → Proposal",
      detail: "weighted at 60% of $32,000",
      time: "9:31",
    },
  ];

  return (
    <Window url="genosyn.com / revenue / deals — board">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 text-[11px]">
        <TrendingUp className="h-3.5 w-3.5 text-zinc-600" />
        <span className="font-medium text-zinc-800">Deals</span>
        <Tag tone="bg-paper-200 text-zinc-800 ring-paper-400">7 stages</Tag>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          weighted $128,400 · coverage 3.2x
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="border-b border-zinc-100 p-5 md:col-span-3 md:border-b-0 md:border-r">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stages.map((s) => (
              <div key={s.label} className="bg-paper-100/70 p-2 ring-1 ring-zinc-900/[0.06]">
                <div className="flex items-center justify-between px-1 pb-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-600">
                  <span className="truncate">{s.label}</span>
                  <span className="font-mono text-zinc-600">{s.count}</span>
                </div>
                <div className="border border-zinc-200 bg-white p-2.5">
                  <div className="truncate text-[12px] font-medium text-zinc-900">
                    {s.deal.name}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] tabular-nums text-zinc-600">
                    {s.deal.amount}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span
                      className={`flex h-5 w-5 items-center justify-center text-[8px] font-semibold ${s.deal.color}`}
                    >
                      {s.deal.who}
                    </span>
                    {s.deal.isAI && (
                      <span className="bg-zinc-100 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-zinc-900 ring-1 ring-zinc-300">
                        AI
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-600">
            <CheckCircle2 className="h-3.5 w-3.5 text-zinc-800" />
            <span>Won deals bill from the same database — invoice, payment, journal entry</span>
          </div>
        </div>
        <div className="p-5 md:col-span-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-zinc-950">
              Globex · renewal expansion
            </span>
            <span className="font-mono text-[10px] text-zinc-600">timeline</span>
          </div>
          <div className="mt-3 space-y-2">
            {timeline.map((t) => (
              <div key={t.label} className="flex items-start gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center ${t.tone}`}
                >
                  <t.icon className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-medium text-zinc-900">{t.label}</div>
                  <div className="text-[10px] leading-4 text-zinc-600">{t.detail}</div>
                </div>
                <span className="font-mono text-[9.5px] text-zinc-600">{t.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-100 bg-paper-100/60 px-5 py-2.5 text-[10.5px] text-zinc-600">
        {REVENUE_LOOP.map((step, i) => (
          <span key={step} className="inline-flex items-center gap-1.5">
            {i > 0 && <ArrowRight aria-hidden className="h-3 w-3 text-zinc-300" />}
            <span
              className={` px-1.5 py-0.5 font-medium ${
                i === REVENUE_LOOP.length - 1
                  ? "bg-zinc-950 text-white"
                  : "bg-white text-zinc-700 ring-1 ring-zinc-900/[0.08]"
              }`}
            >
              {step}
            </span>
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">one database</span>
      </div>
    </Window>
  );
}

// ────────────────────────────────── Email ───────────────────────────────────

function EmailPreview() {
  return (
    <Window url="genosyn.com / mail / inbox">
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="divide-y divide-zinc-100 border-b border-zinc-100 md:col-span-2 md:border-b-0 md:border-r">
          {[
            { from: "Dana · Acme Co.", subject: "Invoice question", tag: "billing", active: true },
            { from: "signups@", subject: "3 new trials today", tag: null, active: false },
            {
              from: "Lee · Globex",
              subject: "Renewal call next week?",
              tag: "renewal",
              active: false,
            },
          ].map((m) => (
            <div key={m.subject} className={`px-4 py-3 ${m.active ? "bg-paper-100" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-900">{m.from}</span>
                {m.tag && (
                  <span className="bg-paper-200 px-1.5 py-0.5 text-[9px] font-medium text-zinc-800 ring-1 ring-paper-400">
                    {m.tag}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-zinc-700">{m.subject}</div>
            </div>
          ))}
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-zinc-600" />
            <span className="text-[12.5px] font-semibold text-zinc-950">Invoice question</span>
            <span className="ml-auto font-mono text-[10px] text-zinc-600">9:41 AM</span>
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-zinc-700">
            Hi — our March invoice shows two seats but we downgraded to one on the 3rd. Can you take
            a look?
          </p>
          <div className="mt-4 border border-zinc-300 bg-zinc-100/50 p-3.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-900">
              <Sparkles className="h-3 w-3" />
              Draft by Mira (AI) · rule: to contains support@
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-zinc-800">
              Hi Dana — you&apos;re right, the seat change landed after the invoice was issued.
              I&apos;ve credited the difference ($29) to your April invoice…
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span className="bg-night-950 px-3 py-1.5 text-[11px] font-semibold text-white">
                Send
              </span>
              <span className="border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-medium text-zinc-700">
                Edit draft
              </span>
              <span className="ml-auto text-[10px] font-medium text-zinc-600">
                grant level: draft
              </span>
            </div>
          </div>
        </div>
      </div>
    </Window>
  );
}

// ──────────────────────────────── Customers ─────────────────────────────────

function CustomersPreview() {
  return (
    <Window url="genosyn.com / customers / acme-corp — statement">
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="border-b border-zinc-100 p-5 md:col-span-2 md:border-b-0 md:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center bg-paper-200 text-sm font-semibold text-zinc-800">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold text-zinc-950">Acme Corp</div>
              <div className="text-xs text-zinc-600">billing@acme.com · USD</div>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-zinc-600">Annual Contract Value</dt>
              <dd className="font-medium tabular-nums text-zinc-950">$14,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-600">Outstanding</dt>
              <dd className="font-medium tabular-nums text-zinc-950">$2,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-600">Lifetime billed</dt>
              <dd className="font-medium tabular-nums text-zinc-950">$38,800</dd>
            </div>
          </dl>
          <div className="mt-4 inline-flex items-center gap-1.5 border border-zinc-200 bg-paper-100 px-2.5 py-1.5 text-[11px] font-medium text-zinc-700">
            <FileText className="h-3 w-3" />
            MSA — signed Mar 2025
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-zinc-800">Statement · year to date</span>
            <span className="font-mono text-[10px] text-zinc-600">PDF ↓</span>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {[
              { label: "ACME-CORP-INV-0007", date: "Jun 1", amt: "$1,200", credit: false },
              { label: "Payment — wire", date: "May 12", amt: "$1,200", credit: true },
              { label: "ACME-CORP-INV-0006", date: "May 1", amt: "$1,200", credit: false },
            ].map((row) => (
              <div
                key={row.label + row.date}
                className="flex items-center justify-between border border-zinc-100 bg-white px-3 py-2"
              >
                <span className="font-medium text-zinc-800">{row.label}</span>
                <span className="text-[10px] text-zinc-600">{row.date}</span>
                <span
                  className={`tabular-nums font-medium ${row.credit ? "text-zinc-800" : "text-zinc-900"}`}
                >
                  {row.credit ? "−" : ""}
                  {row.amt}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5 text-center">
            {[
              { label: "current", amt: "$1.2k", tone: "bg-paper-200 text-zinc-800" },
              { label: "1–30", amt: "$1.2k", tone: "bg-signal-500 text-zinc-950" },
              { label: "31–60", amt: "—", tone: "bg-paper-100 text-zinc-600" },
              { label: "61–90", amt: "—", tone: "bg-paper-100 text-zinc-600" },
              { label: "90+", amt: "—", tone: "bg-paper-100 text-zinc-600" },
            ].map((b) => (
              <div key={b.label} className={` px-1 py-1.5 ${b.tone}`}>
                <div className="text-[9px] font-semibold uppercase tracking-wide">{b.label}</div>
                <div className="text-[11px] font-semibold tabular-nums">{b.amt}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Window>
  );
}

// ───────────────────────────────── Finance ──────────────────────────────────

function FinancePreview() {
  return (
    <Window url="genosyn.com / finance / invoices / ACME-CORP-INV-0007">
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className="border-b border-zinc-100 p-5 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-zinc-950">ACME-CORP-INV-0007</span>
            <Tag tone="bg-paper-200 text-zinc-800 ring-paper-400">Paid</Tag>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            <div className="flex justify-between text-zinc-700">
              <span>Pro plan · 12 seats</span>
              <span className="tabular-nums">$1,080.00</span>
            </div>
            <div className="flex justify-between text-zinc-700">
              <span>Priority support</span>
              <span className="tabular-nums">$120.00</span>
            </div>
            <div className="flex justify-between border-t border-zinc-100 pt-1.5 text-zinc-600">
              <span>VAT 20% (exclusive)</span>
              <span className="tabular-nums">$240.00</span>
            </div>
            <div className="flex justify-between text-[13px] font-semibold text-zinc-950">
              <span>Total</span>
              <span className="tabular-nums">$1,440.00</span>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-zinc-600">
            <Landmark className="h-3 w-3" />
            recurring · every month on the 1st · auto-issue + email PDF
          </div>
        </div>
        <div className="p-5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            Auto-posted journal entry
          </div>
          <div className="mt-3 space-y-1.5 font-mono text-[11px]">
            {[
              { acct: "1100 Bank", dr: "$1,440.00", cr: "" },
              { acct: "1200 Accounts Receivable", dr: "", cr: "$1,440.00" },
            ].map((l) => (
              <div
                key={l.acct}
                className="flex items-center justify-between border border-zinc-100 bg-paper-100/60 px-3 py-2"
              >
                <span className="text-zinc-800">{l.acct}</span>
                <span className="w-20 text-right tabular-nums text-zinc-950">{l.dr}</span>
                <span className="w-20 text-right tabular-nums text-zinc-600">{l.cr}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-zinc-800">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ledger balanced
            </span>
            <span className="font-mono text-[10px] text-zinc-600">
              trial balance ✓ · period open
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-1.5 text-center text-[10px]">
            {["P&L", "Balance sheet", "Cash flow"].map((r) => (
              <span
                key={r}
                className="border border-zinc-200 bg-white px-2 py-1.5 font-medium text-zinc-700"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Window>
  );
}

// ─────────────────────────────────── Code ───────────────────────────────────

function CodePreview() {
  return (
    <Window url="genosyn.com / code / api-server">
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="border-b border-zinc-100 p-4 md:col-span-2 md:border-b-0 md:border-r">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            Repositories
          </div>
          <div className="mt-2 space-y-2">
            {[
              {
                name: "api-server",
                grant: "work locally",
                tone: "bg-paper-200 text-zinc-800 ring-paper-400",
              },
              {
                name: "marketing-site",
                grant: "work locally",
                tone: "bg-paper-200 text-zinc-800 ring-paper-400",
              },
              {
                name: "infra",
                grant: "reference only",
                tone: "bg-paper-200 text-zinc-700 ring-zinc-900/[0.08]",
              },
            ].map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between border border-zinc-200 bg-white px-3 py-2"
              >
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-800">
                  <GitBranch className="h-3 w-3 text-zinc-600" />
                  {r.name}
                </span>
                <Tag tone={r.tone}>{r.grant}</Tag>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-600">
            <Star className="h-3 w-3" />
            granted to Sam (AI) · SSH deploy key, encrypted
          </div>
        </div>
        <div className="p-4 md:col-span-3">
          <div className="bg-night-950 p-4 font-mono text-[11px] leading-5">
            <div className="flex items-center gap-1.5 pb-2 text-[10px] uppercase tracking-widest text-zinc-400">
              <Terminal className="h-3 w-3" />
              sam@genosyn · code-repos/api-server
            </div>
            <div className="text-zinc-400">$ git checkout -b fix/rate-limit-headers</div>
            <div className="text-zinc-400">
              $ git commit -m &quot;Return Retry-After on 429s&quot;
            </div>
            <div className="text-zinc-400">
              [fix/rate-limit-headers 3f2a91c] 2 files changed, 18 insertions(+)
            </div>
            <div className="text-zinc-400">$ git status --short --branch</div>
            <div className="text-paper-50">✓ local commit ready for governed publishing</div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-600">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>
              committed as{" "}
              <span className="font-mono text-[10px] text-zinc-800">
                Sam &lt;sam@genosyn.local&gt;
              </span>{" "}
              · checkout persists between Runs
            </span>
          </div>
        </div>
      </div>
    </Window>
  );
}
