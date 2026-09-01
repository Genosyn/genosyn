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
      <div className="flex h-11 items-center gap-2 border-b border-hairline bg-white px-3 text-ink2">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="h-4 w-4 rounded-full border-[1.5px] border-ink" />
          <span className="hidden text-[9px] font-bold tracking-[0.2em] text-ink sm:inline">
            GENOSYN
          </span>
        </div>
        <span className="h-4 w-px shrink-0 bg-hairline" />
        <div className="inline-flex min-w-0 items-center gap-1 px-1.5 py-1 text-[10px] font-semibold text-ink">
          <span className="truncate">Northstar Labs</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        </div>
        <span className="hidden text-muted sm:inline">/</span>
        <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
          <span className="h-4 w-4 rounded bg-hairline text-center text-[9px] font-bold leading-4 text-ink">
            G
          </span>
          <span className="max-w-48 truncate text-[10px] font-medium text-ink2">
            {url.replace("genosyn.com /", "")}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="hidden rounded border border-hairline bg-ground px-1.5 py-0.5 text-[8px] font-medium text-muted sm:inline">
            ⌘ K
          </span>
          <span className="flex h-6 w-6 items-center justify-center text-muted">
            <Bell className="h-3 w-3" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[8px] font-semibold text-white">
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
        <div className="border-b border-ground p-5 md:col-span-2 md:border-b-0 md:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center bg-ground text-sm font-semibold text-ink2">
              MF
            </span>
            <div>
              <div className="text-sm font-semibold text-ink">Mira</div>
              <div className="text-xs text-muted">Bookkeeper · AI Employee</div>
            </div>
            <span className="ml-auto inline-flex items-center gap-1 bg-ink px-2 py-0.5 text-[10px] font-semibold text-ground ring-1 ring-ink2">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink" />
              Running
            </span>
          </div>
          <div className="mt-4 border border-hairline bg-ground/60 p-3.5 font-mono text-[11.5px] leading-5 text-ink2">
            <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted">
              <BookHeart className="h-3 w-3" />
              Soul
            </div>
            <div className="text-ink"># Mira</div>
            <div className="text-muted">Careful, exact, allergic to drift.</div>
            <div className="mt-1.5 font-semibold text-ink">## Never</div>
            <div>- Post an unbalanced entry.</div>
            <div>- Guess an exchange rate.</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["reconcile-stripe", "close-the-month", "chase-overdue"].map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 bg-ground px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink2 ring-1 ring-ink/[0.08]"
              >
                <Sparkles className="h-2.5 w-2.5" />
                {s}
              </span>
            ))}
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2 text-[11px]">
            <CalendarClock className="h-3.5 w-3.5 text-muted" />
            <span className="font-medium text-ink2">Reconcile Stripe</span>
            <span className="font-mono text-[10px] text-muted">0 7 * * *</span>
            <span className="ml-auto font-mono text-[10px] text-muted">Run #212 · live</span>
          </div>
          <div className="mt-3 space-y-1.5 border border-rule bg-ink p-4 font-mono text-[11px] leading-5 text-hairline">
            <div>
              <span className="text-rule">[07:00:02]</span> stripe_list_charges — 42 since yesterday
            </div>
            <div>
              <span className="text-rule">[07:00:19]</span> matched 41 to open invoices
            </div>
            <div>
              <span className="text-rule">[07:00:24]</span> posting DR Bank / CR Accounts Receivable
            </div>
            <div>
              <span className="text-rule">[07:00:31]</span> <span className="text-surface">✓</span>
              {""}
              ledger balanced — 1 charge flagged for review
            </div>
            <div>
              <span className="text-rule">[07:00:33]</span> send_workspace_message → #finance
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-ink2" />
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
      <div className="flex items-center gap-2 border-b border-ground px-5 py-2.5 text-[11px]">
        <Hash className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium text-ink2">marketing</span>
        <span className="text-muted">· Launch week comms</span>
        <span className="ml-auto font-mono text-[10px] text-muted">4 online</span>
      </div>
      <div className="space-y-4 px-5 py-5">
        <ChatLine
          initials="ND"
          color="bg-ink text-white"
          name="Nawaz"
          time="9:12 AM"
          message={
            <>@Alex the launch brief is attached — can you turn it into the Friday digest?</>
          }
          attachment="launch-brief.pdf"
        />
        <ChatLine
          initials="AB"
          color="bg-ground text-ink2"
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
        <div className="flex items-center gap-2 pl-9 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-ground px-2.5 py-1">
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
          <span className="text-[12px] font-semibold text-ink">{name}</span>
          {isAI && (
            <span className="bg-ground px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink ring-1 ring-hairline">
              AI
            </span>
          )}
          <span className="text-[11px] text-muted">{time}</span>
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink2">{message}</div>
        {attachment && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 border border-hairline bg-ground px-2.5 py-1.5 text-[11px] font-medium text-ink2">
            <Paperclip className="h-3 w-3" />
            {attachment}
          </div>
        )}
        {reaction && (
          <div className="mt-1.5 inline-flex items-center rounded-full border border-hairline bg-white px-2 py-0.5 text-[10px] text-ink2">
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
          color: "bg-ground text-ink2",
        },
        {
          id: "MKT-7",
          title: "Draft Friday digest",
          who: "AB",
          color: "bg-ground text-ink2",
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
          color: "bg-ink text-ground",
          isAI: true,
          review: true,
        },
        {
          id: "ENG-38",
          title: "Rotate webhook secrets",
          who: "SS",
          color: "bg-ground text-ink2",
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
          color: "bg-ground text-ink2",
          isAI: true,
        },
      ],
    },
  ];
  return (
    <Window url="genosyn.com / tasks / launch-week — board">
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
        {cols.map((col) => (
          <div key={col.label} className="bg-ground/70 p-2.5 ring-1 ring-ink/[0.06]">
            <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {col.label}
              <span className="font-mono text-muted">{col.count}</span>
            </div>
            <div className="space-y-2">
              {col.cards.map((card) => (
                <div key={card.id} className="border border-hairline bg-white p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-medium text-muted">{card.id}</span>
                    {card.review && <Tag tone="bg-ink text-ground ring-ink2">awaiting review</Tag>}
                  </div>
                  <div className="mt-1 text-[12.5px] font-medium leading-snug text-ink">
                    {card.title}
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span
                      className={`flex h-5 w-5 items-center justify-center text-[8px] font-semibold ${card.color}`}
                    >
                      {card.who}
                    </span>
                    {card.isAI && (
                      <span className="bg-ground px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-ink ring-1 ring-hairline">
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
      tone: "bg-ground text-ink2 ring-rule",
      owner: "SS",
      ownerColor: "bg-ground text-ink2",
      acv: "$14,400",
    },
    {
      name: "Globex",
      stage: "Proposal",
      tone: "bg-ground text-ink ring-hairline",
      owner: "AB",
      ownerColor: "bg-ground text-ink2",
      acv: "$32,000",
    },
    {
      name: "Initech",
      stage: "Discovery",
      tone: "bg-ink text-ground ring-ink2",
      owner: "SS",
      ownerColor: "bg-ground text-ink2",
      acv: "$9,600",
    },
    {
      name: "Umbrella",
      stage: "Won",
      tone: "bg-ground text-ink2 ring-rule",
      owner: "AB",
      ownerColor: "bg-ground text-ink2",
      acv: "$21,000",
    },
  ];
  return (
    <Window url="genosyn.com / bases / sales-crm">
      <div className="flex items-center gap-2 border-b border-ground px-5 py-2.5 text-[11px]">
        <Table2 className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium text-ink2">Deals</span>
        <span className="bg-ground px-1.5 py-0.5 text-[10px] font-medium text-muted">
          view: Pipeline
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-muted">
          filtered · sorted by ACV
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px]">
          <thead>
            <tr className="border-b border-ground text-[10px] uppercase tracking-wider text-muted">
              <th className="px-5 py-2 text-left font-medium">Company</th>
              <th className="px-3 py-2 text-left font-medium">Stage</th>
              <th className="px-3 py-2 text-left font-medium">Owner</th>
              <th className="px-5 py-2 text-right font-medium">ACV</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ground text-[12.5px]">
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="px-5 py-2.5 font-medium text-ink">{r.name}</td>
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
                <td className="px-5 py-2.5 text-right tabular-nums text-ink">{r.acv}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-ground bg-ground/60 px-5 py-2.5 text-[11px] text-muted">
        <Sparkles className="h-3.5 w-3.5 text-ink2" />
        <span>
          <span className="font-medium text-ink2">Alex (AI)</span> updated 3 rows from
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
        <div className="border-b border-ground p-4 md:border-b-0 md:border-r">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Ops notebook
          </div>
          <ul className="mt-2 space-y-1 text-[12px] text-ink2">
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-muted" />
              Onboarding SOP
            </li>
            <li className="flex items-center gap-1.5 bg-ground px-1.5 py-1 font-medium text-ink">
              <StickyNote className="h-3 w-3 text-muted" />
              Incident runbook
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-muted" />
              Sev-1 checklist
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-muted" />
              Postmortem template
            </li>
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-muted" />
              Vendor contacts
            </li>
          </ul>
        </div>
        <div className="p-5 md:col-span-2">
          <div className="text-lg font-semibold text-ink">🚨 Incident runbook</div>
          <div className="mt-1 text-[11px] text-muted">
            Last edited by <span className="font-medium text-ink2">Sam (AI)</span> · 2 hours ago ·
            audit-logged
          </div>
          <div className="mt-4 space-y-2.5 text-[12.5px] leading-relaxed text-ink2">
            <div className="font-semibold text-ink">## First five minutes</div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center rounded border border-hairline bg-white">
                <CheckCircle2 className="h-3 w-3 text-ink2" />
              </span>
              Page the on-call — Sam watches p99 every 15 min
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded border border-hairline bg-white" />
              Open a #incident channel and pin the timeline
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded border border-hairline bg-white" />
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
      tone: "bg-ground text-ink2 ring-rule",
      meta: "extracted · 41k chars",
    },
    {
      icon: FileText,
      label: "SOC 2 readiness guide.pdf",
      kind: "PDF",
      tone: "bg-ground text-ink2 ring-rule",
      meta: "18 pages",
    },
    {
      icon: Library,
      label: "The Mom Test",
      kind: "EPUB",
      tone: "bg-ground text-ink2 ring-rule",
      meta: "12 chapters",
    },
    {
      icon: Mic,
      label: "All-hands · Q1 retro",
      kind: "Transcript",
      tone: "bg-ink text-ground ring-ink2",
      meta: "48 min",
    },
  ];
  return (
    <Window url="genosyn.com / resources">
      <div className="flex items-center gap-2 border-b border-ground px-5 py-3">
        <div className="flex flex-1 items-center gap-2 border border-hairline bg-ground/60 px-3 py-1.5 text-[12px] text-muted">
          <Search className="h-3.5 w-3.5" />
          usage-based billing
        </div>
        <span className="font-mono text-[10px] text-muted">2 matches</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col border border-hairline bg-white p-3">
            <Tag tone={it.tone}>
              <it.icon className="h-3 w-3" />
              {it.kind}
            </Tag>
            <div className="mt-2.5 truncate text-[12.5px] font-medium text-ink">{it.label}</div>
            <div className="mt-1 text-[10px] text-muted">{it.meta}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-ground bg-ground/60 px-5 py-2.5 text-[11px] text-muted">
        <Sparkles className="h-3.5 w-3.5 text-ink2" />
        <span>
          <span className="font-medium text-ink2">Alex (AI)</span> cited the Stripe docs in
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
      <div className="flex items-center gap-2 border-b border-ground px-5 py-2.5 text-[11px]">
        <Workflow className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium text-ink2">stripe-large-charge</span>
        <Tag tone="bg-ground text-ink2 ring-rule">
          <span className="h-1.5 w-1.5 rounded-full bg-ink" />
          Live
        </Tag>
        <span className="ml-auto font-mono text-[10px] text-muted">
          run #88 · completed in 1.2s
        </span>
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto p-5 sm:gap-3">
        <PipelineNode
          icon={Webhook}
          title="Stripe webhook"
          subtitle="Trigger"
          tone="bg-ink text-ground ring-ink2"
        />
        <PipelineConnector />
        <PipelineNode
          icon={GitBranch}
          title="amount &gt; $1,000"
          subtitle="Branch"
          tone="bg-ground text-ink ring-hairline"
        />
        <PipelineConnector />
        <PipelineNode
          icon={Sparkles}
          title="Ask Alex to summarize"
          subtitle="AI Employee"
          tone="bg-ground text-ink2 ring-rule"
        />
        <PipelineConnector />
        <PipelineNode
          icon={MessageSquare}
          title="Post to #wins"
          subtitle="Message"
          tone="bg-ground text-ink ring-ink/[0.12]"
        />
      </div>
      <div className="border-t border-ground bg-ground/60 px-5 py-2.5 font-mono text-[10.5px] text-muted">
        {"{{trigger.body.amount}}"} → $4,200 · branch: true · reply captured →{""}
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
    <div className="flex min-w-[150px] flex-1 flex-col border border-hairline bg-white px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center ring-1 ${tone}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          {subtitle}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-medium text-ink">{title}</div>
    </div>
  );
}

function PipelineConnector() {
  return (
    <div aria-hidden className="flex shrink-0 items-center self-center text-hairline">
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
        <div className="border border-hairline bg-white p-4 sm:col-span-3">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-ink2">
              Daily pacing check · last 7 days
            </div>
            <span className="font-mono text-[10px] text-muted">
              google-ads + meta-ads · Reese (AI)
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {rows.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between border border-ground px-3 py-2"
              >
                <span className="text-[11px] font-medium text-ink">{r.name}</span>
                <span className="font-mono text-[10px] tabular-nums text-muted">{r.spend}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[9px] ${
                    r.ok ? "bg-ground text-ink2" : "bg-ground text-ink2"
                  }`}
                >
                  {r.pace} pace
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 bg-ink p-3 font-mono text-[10px] leading-4 text-rule">
            <div className="text-rule">-- journal · 09:02</div>
            <div>
              Prospecting — PMax pacing 173% → <span className="text-ink">paused</span> (never
              gated). Proposal filed for review.
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <div className="border border-ink2 bg-ink/15 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink">
              Approval pending
            </div>
            <div className="mt-1 text-[11px] font-medium text-ink">
              Google Ads · budget increase · 45.00 USD
            </div>
            <div className="mt-0.5 text-[10px] text-ink2">
              Brand — Search: 30.00 → 45.00/day. CPA $18 vs $25 target.
            </div>
            <div className="mt-3 flex gap-2">
              <span className="bg-ink px-2.5 py-1 text-[10px] font-medium text-white">Approve</span>
              <span className="border border-hairline bg-white px-2.5 py-1 text-[10px] font-medium text-ink2">
                Reject
              </span>
            </div>
          </div>
          <div className="flex-1 border border-hairline bg-white p-4">
            <div className="text-[11px] font-semibold text-ink2">Connection caps</div>
            <div className="mt-2 flex flex-col gap-1.5 font-mono text-[10px] text-muted">
              <div className="flex justify-between">
                <span>max single increase</span>
                <span className="text-ink">$250</span>
              </div>
              <div className="flex justify-between">
                <span>daily increases</span>
                <span className="text-ink">$120 / $500</span>
              </div>
              <div className="flex justify-between">
                <span>30-day increases</span>
                <span className="text-ink">$980 / $5,000</span>
              </div>
              <div className="flex justify-between">
                <span>kill switch</span>
                <span className="text-ink2">off</span>
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
        <div className="border border-hairline bg-white p-4 sm:col-span-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-ink2">MRR by month</div>
            <span className="font-mono text-[10px] text-muted">postgres · 8 rows</span>
          </div>
          <div className="mt-4 flex h-28 items-end gap-2">
            {bars.map((h, i) => (
              <div
                key={i}
                className={`flex-1 rounded-t-md ${i === bars.length - 1 ? "bg-ink" : "bg-hairline"}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[9px] text-muted">
            <span>Nov</span>
            <span>Jun</span>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="border border-hairline bg-white p-4">
            <div className="text-[11px] font-semibold text-ink2">MRR</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">
              $48,220
            </div>
            <div className="mt-0.5 text-[10px] font-medium text-ink2">+8.4% vs last month</div>
          </div>
          <div className="flex-1 border border-rule bg-ink p-3.5 font-mono text-[10px] leading-4 text-rule">
            <div className="text-rule">-- saved chart · run by Mira (AI)</div>
            <div>
              <span className="text-hairline">select</span> month,{""}
              <span className="text-hairline">sum</span>(mrr)
            </div>
            <div>
              <span className="text-hairline">from</span> subscriptions
            </div>
            <div>
              <span className="text-hairline">group by</span> 1{""}
              <span className="text-hairline">order by</span> 1;
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
        color: "bg-ground text-ink2",
      },
    },
    {
      label: "Demo",
      count: 4,
      deal: {
        name: "Umbrella",
        amount: "$21,000",
        who: "AB",
        color: "bg-ground text-ink2",
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
        color: "bg-ground text-ink2",
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
        color: "bg-ground text-ink2",
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
      tone: "bg-ground text-ink2",
      label: "email in · Lee at Globex",
      detail: "matched to a known contact by mail sync",
      time: "9:12",
    },
    {
      icon: Zap,
      tone: "bg-ink text-ground",
      label: "signal · seats +4 on the trial",
      detail: "saved query on cron · fired once for this account",
      time: "9:14",
    },
    {
      icon: Sparkles,
      tone: "bg-ground text-ink",
      label: "sequence step 2 · drafted by Alex (AI)",
      detail: "waiting in the review queue for a human Send",
      time: "9:15",
    },
    {
      icon: TrendingUp,
      tone: "bg-ground text-ink2",
      label: "stage change · Demo → Proposal",
      detail: "weighted at 60% of $32,000",
      time: "9:31",
    },
  ];

  return (
    <Window url="genosyn.com / revenue / deals — board">
      <div className="flex items-center gap-2 border-b border-ground px-5 py-2.5 text-[11px]">
        <TrendingUp className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium text-ink2">Deals</span>
        <Tag tone="bg-ground text-ink2 ring-rule">7 stages</Tag>
        <span className="ml-auto font-mono text-[10px] text-muted">
          weighted $128,400 · coverage 3.2x
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="border-b border-ground p-5 md:col-span-3 md:border-b-0 md:border-r">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stages.map((s) => (
              <div key={s.label} className="bg-ground/70 p-2 ring-1 ring-ink/[0.06]">
                <div className="flex items-center justify-between px-1 pb-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-muted">
                  <span className="truncate">{s.label}</span>
                  <span className="font-mono text-muted">{s.count}</span>
                </div>
                <div className="border border-hairline bg-white p-2.5">
                  <div className="truncate text-[12px] font-medium text-ink">{s.deal.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] tabular-nums text-muted">
                    {s.deal.amount}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span
                      className={`flex h-5 w-5 items-center justify-center text-[8px] font-semibold ${s.deal.color}`}
                    >
                      {s.deal.who}
                    </span>
                    {s.deal.isAI && (
                      <span className="bg-ground px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-ink ring-1 ring-hairline">
                        AI
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-ink2" />
            <span>Won deals bill from the same database — invoice, payment, journal entry</span>
          </div>
        </div>
        <div className="p-5 md:col-span-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-ink">Globex · renewal expansion</span>
            <span className="font-mono text-[10px] text-muted">timeline</span>
          </div>
          <div className="mt-3 space-y-2">
            {timeline.map((t) => (
              <div key={t.label} className="flex items-start gap-2">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${t.tone}`}>
                  <t.icon className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-medium text-ink">{t.label}</div>
                  <div className="text-[10px] leading-4 text-muted">{t.detail}</div>
                </div>
                <span className="font-mono text-[9.5px] text-muted">{t.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-ground bg-ground/60 px-5 py-2.5 text-[10.5px] text-muted">
        {REVENUE_LOOP.map((step, i) => (
          <span key={step} className="inline-flex items-center gap-1.5">
            {i > 0 && <ArrowRight aria-hidden className="h-3 w-3 text-hairline" />}
            <span
              className={` px-1.5 py-0.5 font-medium ${
                i === REVENUE_LOOP.length - 1
                  ? "bg-ink text-white"
                  : "bg-white text-ink2 ring-1 ring-ink/[0.08]"
              }`}
            >
              {step}
            </span>
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-muted">one database</span>
      </div>
    </Window>
  );
}

// ────────────────────────────────── Email ───────────────────────────────────

function EmailPreview() {
  return (
    <Window url="genosyn.com / mail / inbox">
      <div className="grid grid-cols-1 md:grid-cols-5">
        <div className="divide-y divide-ground border-b border-ground md:col-span-2 md:border-b-0 md:border-r">
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
            <div key={m.subject} className={`px-4 py-3 ${m.active ? "bg-ground" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-ink">{m.from}</span>
                {m.tag && (
                  <span className="bg-ground px-1.5 py-0.5 text-[9px] font-medium text-ink2 ring-1 ring-rule">
                    {m.tag}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-ink2">{m.subject}</div>
            </div>
          ))}
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted" />
            <span className="text-[12.5px] font-semibold text-ink">Invoice question</span>
            <span className="ml-auto font-mono text-[10px] text-muted">9:41 AM</span>
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink2">
            Hi — our March invoice shows two seats but we downgraded to one on the 3rd. Can you take
            a look?
          </p>
          <div className="mt-4 border border-hairline bg-ground/50 p-3.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink">
              <Sparkles className="h-3 w-3" />
              Draft by Mira (AI) · rule: to contains support@
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink2">
              Hi Dana — you&apos;re right, the seat change landed after the invoice was issued.
              I&apos;ve credited the difference ($29) to your April invoice…
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span className="bg-ink px-3 py-1.5 text-[11px] font-semibold text-white">Send</span>
              <span className="border border-hairline bg-white px-3 py-1.5 text-[11px] font-medium text-ink2">
                Edit draft
              </span>
              <span className="ml-auto text-[10px] font-medium text-muted">grant level: draft</span>
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
        <div className="border-b border-ground p-5 md:col-span-2 md:border-b-0 md:border-r">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center bg-ground text-sm font-semibold text-ink2">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold text-ink">Acme Corp</div>
              <div className="text-xs text-muted">billing@acme.com · USD</div>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-muted">Annual Contract Value</dt>
              <dd className="font-medium tabular-nums text-ink">$14,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Outstanding</dt>
              <dd className="font-medium tabular-nums text-ink">$2,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Lifetime billed</dt>
              <dd className="font-medium tabular-nums text-ink">$38,800</dd>
            </div>
          </dl>
          <div className="mt-4 inline-flex items-center gap-1.5 border border-hairline bg-ground px-2.5 py-1.5 text-[11px] font-medium text-ink2">
            <FileText className="h-3 w-3" />
            MSA — signed Mar 2025
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-ink2">Statement · year to date</span>
            <span className="font-mono text-[10px] text-muted">PDF ↓</span>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {[
              { label: "ACME-CORP-INV-0007", date: "Jun 1", amt: "$1,200", credit: false },
              { label: "Payment — wire", date: "May 12", amt: "$1,200", credit: true },
              { label: "ACME-CORP-INV-0006", date: "May 1", amt: "$1,200", credit: false },
            ].map((row) => (
              <div
                key={row.label + row.date}
                className="flex items-center justify-between border border-ground bg-white px-3 py-2"
              >
                <span className="font-medium text-ink2">{row.label}</span>
                <span className="text-[10px] text-muted">{row.date}</span>
                <span
                  className={`tabular-nums font-medium ${row.credit ? "text-ink2" : "text-ink"}`}
                >
                  {row.credit ? "−" : ""}
                  {row.amt}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5 text-center">
            {[
              { label: "current", amt: "$1.2k", tone: "bg-ground text-ink2" },
              { label: "1–30", amt: "$1.2k", tone: "bg-ink text-ground" },
              { label: "31–60", amt: "—", tone: "bg-ground text-muted" },
              { label: "61–90", amt: "—", tone: "bg-ground text-muted" },
              { label: "90+", amt: "—", tone: "bg-ground text-muted" },
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
        <div className="border-b border-ground p-5 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-ink">ACME-CORP-INV-0007</span>
            <Tag tone="bg-ground text-ink2 ring-rule">Paid</Tag>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            <div className="flex justify-between text-ink2">
              <span>Pro plan · 12 seats</span>
              <span className="tabular-nums">$1,080.00</span>
            </div>
            <div className="flex justify-between text-ink2">
              <span>Priority support</span>
              <span className="tabular-nums">$120.00</span>
            </div>
            <div className="flex justify-between border-t border-ground pt-1.5 text-muted">
              <span>VAT 20% (exclusive)</span>
              <span className="tabular-nums">$240.00</span>
            </div>
            <div className="flex justify-between text-[13px] font-semibold text-ink">
              <span>Total</span>
              <span className="tabular-nums">$1,440.00</span>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-muted">
            <Landmark className="h-3 w-3" />
            recurring · every month on the 1st · auto-issue + email PDF
          </div>
        </div>
        <div className="p-5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Auto-posted journal entry
          </div>
          <div className="mt-3 space-y-1.5 font-mono text-[11px]">
            {[
              { acct: "1100 Bank", dr: "$1,440.00", cr: "" },
              { acct: "1200 Accounts Receivable", dr: "", cr: "$1,440.00" },
            ].map((l) => (
              <div
                key={l.acct}
                className="flex items-center justify-between border border-ground bg-ground/60 px-3 py-2"
              >
                <span className="text-ink2">{l.acct}</span>
                <span className="w-20 text-right tabular-nums text-ink">{l.dr}</span>
                <span className="w-20 text-right tabular-nums text-muted">{l.cr}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-ink2">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ledger balanced
            </span>
            <span className="font-mono text-[10px] text-muted">trial balance ✓ · period open</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-1.5 text-center text-[10px]">
            {["P&L", "Balance sheet", "Cash flow"].map((r) => (
              <span
                key={r}
                className="border border-hairline bg-white px-2 py-1.5 font-medium text-ink2"
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
        <div className="border-b border-ground p-4 md:col-span-2 md:border-b-0 md:border-r">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Repositories
          </div>
          <div className="mt-2 space-y-2">
            {[
              {
                name: "api-server",
                grant: "work locally",
                tone: "bg-ground text-ink2 ring-rule",
              },
              {
                name: "marketing-site",
                grant: "work locally",
                tone: "bg-ground text-ink2 ring-rule",
              },
              {
                name: "infra",
                grant: "reference only",
                tone: "bg-ground text-ink2 ring-ink/[0.08]",
              },
            ].map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between border border-hairline bg-white px-3 py-2"
              >
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink2">
                  <GitBranch className="h-3 w-3 text-muted" />
                  {r.name}
                </span>
                <Tag tone={r.tone}>{r.grant}</Tag>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted">
            <Star className="h-3 w-3" />
            granted to Sam (AI) · SSH deploy key, encrypted
          </div>
        </div>
        <div className="p-4 md:col-span-3">
          <div className="bg-ink p-4 font-mono text-[11px] leading-5">
            <div className="flex items-center gap-1.5 pb-2 text-[10px] uppercase tracking-widest text-rule">
              <Terminal className="h-3 w-3" />
              sam@genosyn · code-repos/api-server
            </div>
            <div className="text-rule">$ git checkout -b fix/rate-limit-headers</div>
            <div className="text-rule">$ git commit -m &quot;Return Retry-After on 429s&quot;</div>
            <div className="text-rule">
              [fix/rate-limit-headers 3f2a91c] 2 files changed, 18 insertions(+)
            </div>
            <div className="text-rule">$ git status --short --branch</div>
            <div className="text-surface">✓ local commit ready for governed publishing</div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>
              committed as{""}
              <span className="font-mono text-[10px] text-ink2">Sam &lt;sam@genosyn.local&gt;</span>
              {""}· checkout persists between Runs
            </span>
          </div>
        </div>
      </div>
    </Window>
  );
}
