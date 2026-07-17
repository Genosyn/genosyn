import type { ReactNode } from "react";
import {
  ArrowRight,
  BookHeart,
  Building2,
  CalendarClock,
  CheckCircle2,
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
  Webhook,
  Workflow,
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
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lift">
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/60 px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
        </div>
        <div className="ml-2 inline-flex min-w-0 items-center gap-2 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-card">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate">{url}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function Tag({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${tone}`}
    >
      {children}
    </span>
  );
}

function Avatar({ initials, color }: { initials: string; color: string }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold ${color}`}
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
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-sm font-semibold text-emerald-700">
              MF
            </span>
            <div>
              <div className="text-sm font-semibold text-zinc-950">Mira</div>
              <div className="text-xs text-zinc-500">Bookkeeper · AI Employee</div>
            </div>
            <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Running
            </span>
          </div>
          <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3.5 font-mono text-[11.5px] leading-5 text-zinc-700">
            <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              <BookHeart className="h-3 w-3" />
              Soul
            </div>
            <div className="text-zinc-950"># Mira</div>
            <div className="text-zinc-500">Careful, exact, allergic to drift.</div>
            <div className="mt-1.5 font-semibold text-zinc-950">## Never</div>
            <div>- Post an unbalanced entry.</div>
            <div>- Guess an exchange rate.</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["reconcile-stripe", "close-the-month", "chase-overdue"].map((s) => (
              <span
                key={s}
                className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-600 ring-1 ring-zinc-200/70"
              >
                <Sparkles className="h-2.5 w-2.5" />
                {s}
              </span>
            ))}
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2 text-[11px]">
            <CalendarClock className="h-3.5 w-3.5 text-zinc-500" />
            <span className="font-medium text-zinc-700">Reconcile Stripe</span>
            <span className="font-mono text-[10px] text-zinc-400">0 7 * * *</span>
            <span className="ml-auto font-mono text-[10px] text-zinc-400">
              Run #212 · live
            </span>
          </div>
          <div className="mt-3 space-y-1.5 rounded-xl border border-zinc-200 bg-zinc-950 p-4 font-mono text-[11px] leading-5 text-zinc-300">
            <div>
              <span className="text-zinc-500">[07:00:02]</span> stripe_list_charges
              — 42 since yesterday
            </div>
            <div>
              <span className="text-zinc-500">[07:00:19]</span> matched 41 to open
              invoices
            </div>
            <div>
              <span className="text-zinc-500">[07:00:24]</span> posting DR Bank / CR
              Accounts Receivable
            </div>
            <div>
              <span className="text-zinc-500">[07:00:31]</span>{" "}
              <span className="text-emerald-400">✓</span> ledger balanced — 1 charge
              flagged for review
            </div>
            <div>
              <span className="text-zinc-500">[07:00:33]</span> send_workspace_message
              → #finance
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
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
        <Hash className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">marketing</span>
        <span className="text-zinc-400">· Launch week comms</span>
        <span className="ml-auto font-mono text-[10px] text-zinc-400">4 online</span>
      </div>
      <div className="space-y-4 px-5 py-5">
        <ChatLine
          initials="SS"
          color="bg-emerald-100 text-emerald-700"
          name="Sam"
          time="9:12 AM"
          message={
            <>
              @Alex the launch brief is attached — can you turn it into the Friday
              digest?
            </>
          }
          attachment="launch-brief.pdf"
        />
        <ChatLine
          initials="AB"
          color="bg-sky-100 text-sky-700"
          name="Alex"
          time="9:13 AM"
          isAI
          message={
            <>
              Read it. Draft coming to <span className="font-medium">#marketing</span>{" "}
              by 4 PM — pricing section needs one number from @Mira, pinged her in a
              DM.
            </>
          }
          reaction="👍 2"
        />
        <div className="flex items-center gap-2 pl-9 text-[11px] text-zinc-400">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1">
            <span className="flex gap-0.5">
              <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400 [animation-delay:300ms]" />
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
        {attachment && (
          <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600">
            <Paperclip className="h-3 w-3" />
            {attachment}
          </div>
        )}
        {reaction && (
          <div className="mt-1.5 inline-flex items-center rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] text-zinc-600">
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
    cards: Array<{ id: string; title: string; who: string; color: string; isAI?: boolean; review?: boolean }>;
  }> = [
    {
      label: "In progress",
      count: 3,
      cards: [
        { id: "ENG-42", title: "Ship pricing page A/B test", who: "SS", color: "bg-emerald-100 text-emerald-700" },
        { id: "MKT-7", title: "Draft Friday digest", who: "AB", color: "bg-sky-100 text-sky-700", isAI: true },
      ],
    },
    {
      label: "In review",
      count: 2,
      cards: [
        { id: "FIN-19", title: "March close checklist", who: "MF", color: "bg-amber-100 text-amber-700", isAI: true, review: true },
        { id: "ENG-38", title: "Rotate webhook secrets", who: "SS", color: "bg-emerald-100 text-emerald-700", review: true },
      ],
    },
    {
      label: "Done",
      count: 14,
      cards: [
        { id: "MKT-5", title: "Q2 newsletter calendar", who: "AB", color: "bg-sky-100 text-sky-700", isAI: true },
      ],
    },
  ];
  return (
    <Window url="genosyn.com / tasks / launch-week — board">
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
        {cols.map((col) => (
          <div key={col.label} className="rounded-xl bg-zinc-50/70 p-2.5 ring-1 ring-zinc-100">
            <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {col.label}
              <span className="font-mono text-zinc-400">{col.count}</span>
            </div>
            <div className="space-y-2">
              {col.cards.map((card) => (
                <div key={card.id} className="rounded-lg border border-zinc-200 bg-white p-3 shadow-card">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-medium text-zinc-400">{card.id}</span>
                    {card.review && (
                      <Tag tone="bg-amber-50 text-amber-700 ring-amber-200">awaiting review</Tag>
                    )}
                  </div>
                  <div className="mt-1 text-[12.5px] font-medium leading-snug text-zinc-800">
                    {card.title}
                  </div>
                  <div className="mt-2.5 flex items-center justify-between">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-md text-[8px] font-semibold ${card.color}`}>
                      {card.who}
                    </span>
                    {card.isAI && (
                      <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider text-violet-700 ring-1 ring-violet-200">
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
  const rows: Array<{ name: string; stage: string; tone: string; owner: string; ownerColor: string; acv: string }> = [
    { name: "Acme Co.", stage: "Won", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", owner: "SS", ownerColor: "bg-emerald-100 text-emerald-700", acv: "$14,400" },
    { name: "Globex", stage: "Proposal", tone: "bg-violet-50 text-violet-700 ring-violet-200", owner: "AB", ownerColor: "bg-sky-100 text-sky-700", acv: "$32,000" },
    { name: "Initech", stage: "Discovery", tone: "bg-amber-50 text-amber-700 ring-amber-200", owner: "SS", ownerColor: "bg-emerald-100 text-emerald-700", acv: "$9,600" },
    { name: "Umbrella", stage: "Won", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", owner: "AB", ownerColor: "bg-sky-100 text-sky-700", acv: "$21,000" },
  ];
  return (
    <Window url="genosyn.com / bases / sales-crm">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5 text-[11px]">
        <Table2 className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">Deals</span>
        <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          view: Pipeline
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-400">
          filtered · sorted by ACV
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px]">
        <thead>
          <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wider text-zinc-500">
            <th className="px-5 py-2 text-left font-medium">Company</th>
            <th className="px-3 py-2 text-left font-medium">Stage</th>
            <th className="px-3 py-2 text-left font-medium">Owner</th>
            <th className="px-5 py-2 text-right font-medium">ACV</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 text-[12.5px]">
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="px-5 py-2.5 font-medium text-zinc-800">{r.name}</td>
              <td className="px-3 py-2.5">
                <Tag tone={r.tone}>{r.stage}</Tag>
              </td>
              <td className="px-3 py-2.5">
                <span className={`flex h-5 w-5 items-center justify-center rounded-md text-[8px] font-semibold ${r.ownerColor}`}>
                  {r.owner}
                </span>
              </td>
              <td className="px-5 py-2.5 text-right tabular-nums text-zinc-800">{r.acv}</td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-[11px] text-zinc-500">
        <Sparkles className="h-3.5 w-3.5 text-violet-500" />
        <span>
          <span className="font-medium text-zinc-700">Alex (AI)</span> updated 3 rows
          from yesterday&apos;s calls · audit-logged
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
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Ops notebook
          </div>
          <ul className="mt-2 space-y-1 text-[12px] text-zinc-600">
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-zinc-400" />
              Onboarding SOP
            </li>
            <li className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-1.5 py-1 font-medium text-zinc-900">
              <StickyNote className="h-3 w-3 text-zinc-500" />
              Incident runbook
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-zinc-400" />
              Sev-1 checklist
            </li>
            <li className="flex items-center gap-1.5 pl-4">
              <StickyNote className="h-3 w-3 text-zinc-400" />
              Postmortem template
            </li>
            <li className="flex items-center gap-1.5">
              <StickyNote className="h-3 w-3 text-zinc-400" />
              Vendor contacts
            </li>
          </ul>
        </div>
        <div className="p-5 md:col-span-2">
          <div className="text-lg font-semibold text-zinc-950">🚨 Incident runbook</div>
          <div className="mt-1 text-[11px] text-zinc-400">
            Last edited by <span className="font-medium text-zinc-600">Sam (AI)</span> ·
            2 hours ago · audit-logged
          </div>
          <div className="mt-4 space-y-2.5 text-[12.5px] leading-relaxed text-zinc-700">
            <div className="font-semibold text-zinc-900">## First five minutes</div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center rounded border border-zinc-300 bg-white">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
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
  const items: Array<{ icon: typeof Globe; label: string; kind: string; tone: string; meta: string }> = [
    { icon: Globe, label: "stripe.com/docs/billing", kind: "URL", tone: "bg-sky-50 text-sky-700 ring-sky-200", meta: "extracted · 41k chars" },
    { icon: FileText, label: "SOC 2 readiness guide.pdf", kind: "PDF", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", meta: "18 pages" },
    { icon: Library, label: "The Mom Test", kind: "EPUB", tone: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200", meta: "12 chapters" },
    { icon: Mic, label: "All-hands · Q1 retro", kind: "Transcript", tone: "bg-amber-50 text-amber-700 ring-amber-200", meta: "48 min" },
  ];
  return (
    <Window url="genosyn.com / resources">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-3">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-1.5 text-[12px] text-zinc-500">
          <Search className="h-3.5 w-3.5" />
          usage-based billing
        </div>
        <span className="font-mono text-[10px] text-zinc-400">2 matches</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col rounded-xl border border-zinc-200 bg-white p-3 shadow-card">
            <Tag tone={it.tone}>
              <it.icon className="h-3 w-3" />
              {it.kind}
            </Tag>
            <div className="mt-2.5 truncate text-[12.5px] font-medium text-zinc-800">
              {it.label}
            </div>
            <div className="mt-1 text-[10px] text-zinc-400">{it.meta}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-[11px] text-zinc-500">
        <Sparkles className="h-3.5 w-3.5 text-violet-500" />
        <span>
          <span className="font-medium text-zinc-700">Alex (AI)</span> cited the
          Stripe docs in today&apos;s pricing brief — every employee holds a read
          Grant
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
        <Workflow className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-700">stripe-large-charge</span>
        <Tag tone="bg-emerald-50 text-emerald-700 ring-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Live
        </Tag>
        <span className="ml-auto font-mono text-[10px] text-zinc-400">
          run #88 · completed in 1.2s
        </span>
      </div>
      <div className="flex items-stretch gap-2 overflow-x-auto p-5 sm:gap-3">
        <PipelineNode icon={Webhook} title="Stripe webhook" subtitle="Trigger" tone="bg-amber-50 text-amber-700 ring-amber-200" />
        <PipelineConnector />
        <PipelineNode icon={GitBranch} title="amount &gt; $1,000" subtitle="Branch" tone="bg-violet-50 text-violet-700 ring-violet-200" />
        <PipelineConnector />
        <PipelineNode icon={Sparkles} title="Ask Alex to summarize" subtitle="AI employee" tone="bg-sky-50 text-sky-700 ring-sky-200" />
        <PipelineConnector />
        <PipelineNode icon={MessageSquare} title="Post to #wins" subtitle="Message" tone="bg-indigo-50 text-indigo-700 ring-indigo-200" />
      </div>
      <div className="border-t border-zinc-100 bg-zinc-50/60 px-5 py-2.5 font-mono text-[10.5px] text-zinc-500">
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
    <div className="flex min-w-[150px] flex-1 flex-col rounded-xl border border-zinc-200 bg-white px-3 py-2.5 shadow-card">
      <div className="flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${tone}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {subtitle}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-medium text-zinc-800">{title}</div>
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
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card sm:col-span-3">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-zinc-700">
              Daily pacing check · last 7 days
            </div>
            <span className="font-mono text-[10px] text-zinc-400">
              google-ads + meta-ads · Reese (AI)
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {rows.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2"
              >
                <span className="text-[11px] font-medium text-zinc-800">{r.name}</span>
                <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                  {r.spend}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[9px] ${
                    r.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                  }`}
                >
                  {r.pace} pace
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg bg-zinc-950 p-3 font-mono text-[10px] leading-4 text-zinc-400">
            <div className="text-zinc-500">-- journal · 09:02</div>
            <div>
              Prospecting — PMax pacing 173% → <span className="text-amber-400">paused</span>{" "}
              (never gated). Proposal filed for review.
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-card">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Approval pending
            </div>
            <div className="mt-1 text-[11px] font-medium text-zinc-900">
              Google Ads · budget increase · 45.00 USD
            </div>
            <div className="mt-0.5 text-[10px] text-zinc-600">
              Brand — Search: 30.00 → 45.00/day. CPA $18 vs $25 target.
            </div>
            <div className="mt-3 flex gap-2">
              <span className="rounded-md bg-zinc-900 px-2.5 py-1 text-[10px] font-medium text-white">
                Approve
              </span>
              <span className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[10px] font-medium text-zinc-600">
                Reject
              </span>
            </div>
          </div>
          <div className="flex-1 rounded-xl border border-zinc-200 bg-white p-4 shadow-card">
            <div className="text-[11px] font-semibold text-zinc-700">Connection caps</div>
            <div className="mt-2 flex flex-col gap-1.5 font-mono text-[10px] text-zinc-500">
              <div className="flex justify-between">
                <span>max single increase</span>
                <span className="text-zinc-800">$250</span>
              </div>
              <div className="flex justify-between">
                <span>daily increases</span>
                <span className="text-zinc-800">$120 / $500</span>
              </div>
              <div className="flex justify-between">
                <span>30-day increases</span>
                <span className="text-zinc-800">$980 / $5,000</span>
              </div>
              <div className="flex justify-between">
                <span>kill switch</span>
                <span className="text-emerald-600">off</span>
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
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card sm:col-span-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-semibold text-zinc-700">MRR by month</div>
            <span className="font-mono text-[10px] text-zinc-400">postgres · 8 rows</span>
          </div>
          <div className="mt-4 flex h-28 items-end gap-2">
            {bars.map((h, i) => (
              <div
                key={i}
                className={`flex-1 rounded-t-md ${i === bars.length - 1 ? "bg-zinc-900" : "bg-zinc-200"}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[9px] text-zinc-400">
            <span>Nov</span>
            <span>Jun</span>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-card">
            <div className="text-[11px] font-semibold text-zinc-700">MRR</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-950">
              $48,220
            </div>
            <div className="mt-0.5 text-[10px] font-medium text-emerald-600">
              +8.4% vs last month
            </div>
          </div>
          <div className="flex-1 rounded-xl border border-zinc-200 bg-zinc-950 p-3.5 font-mono text-[10px] leading-4 text-zinc-400">
            <div className="text-zinc-500">-- saved chart · run by Mira (AI)</div>
            <div>
              <span className="text-sky-400">select</span> month,{" "}
              <span className="text-sky-400">sum</span>(mrr)
            </div>
            <div>
              <span className="text-sky-400">from</span> subscriptions
            </div>
            <div>
              <span className="text-sky-400">group by</span> 1{" "}
              <span className="text-sky-400">order by</span> 1;
            </div>
          </div>
        </div>
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
            { from: "Lee · Globex", subject: "Renewal call next week?", tag: "renewal", active: false },
          ].map((m) => (
            <div key={m.subject} className={`px-4 py-3 ${m.active ? "bg-zinc-50" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-800">{m.from}</span>
                {m.tag && (
                  <span className="rounded-md bg-cyan-50 px-1.5 py-0.5 text-[9px] font-medium text-cyan-700 ring-1 ring-cyan-200">
                    {m.tag}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-zinc-600">{m.subject}</div>
            </div>
          ))}
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[12.5px] font-semibold text-zinc-900">
              Invoice question
            </span>
            <span className="ml-auto font-mono text-[10px] text-zinc-400">9:41 AM</span>
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-zinc-600">
            Hi — our March invoice shows two seats but we downgraded to one on the
            3rd. Can you take a look?
          </p>
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-3.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
              <Sparkles className="h-3 w-3" />
              Draft by Mira (AI) · rule: to contains support@
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-zinc-700">
              Hi Dana — you&apos;re right, the seat change landed after the invoice
              was issued. I&apos;ve credited the difference ($29) to your April
              invoice…
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span className="rounded-lg bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold text-white">
                Send
              </span>
              <span className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[11px] font-medium text-zinc-600">
                Edit draft
              </span>
              <span className="ml-auto text-[10px] font-medium text-zinc-400">
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
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-sm font-semibold text-orange-700">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold text-zinc-950">Acme Corp</div>
              <div className="text-xs text-zinc-500">billing@acme.com · USD</div>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Annual Contract Value</dt>
              <dd className="font-medium tabular-nums text-zinc-900">$14,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Outstanding</dt>
              <dd className="font-medium tabular-nums text-zinc-900">$2,400</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Lifetime billed</dt>
              <dd className="font-medium tabular-nums text-zinc-900">$38,800</dd>
            </div>
          </dl>
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600">
            <FileText className="h-3 w-3" />
            MSA — signed Mar 2025
          </div>
        </div>
        <div className="p-5 md:col-span-3">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-zinc-700">Statement · year to date</span>
            <span className="font-mono text-[10px] text-zinc-400">PDF ↓</span>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            {[
              { label: "ACME-CORP-INV-0007", date: "Jun 1", amt: "$1,200", credit: false },
              { label: "Payment — wire", date: "May 12", amt: "$1,200", credit: true },
              { label: "ACME-CORP-INV-0006", date: "May 1", amt: "$1,200", credit: false },
            ].map((row) => (
              <div key={row.label + row.date} className="flex items-center justify-between rounded-lg border border-zinc-100 bg-white px-3 py-2">
                <span className="font-medium text-zinc-700">{row.label}</span>
                <span className="text-[10px] text-zinc-400">{row.date}</span>
                <span className={`tabular-nums font-medium ${row.credit ? "text-emerald-600" : "text-zinc-800"}`}>
                  {row.credit ? "−" : ""}
                  {row.amt}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1.5 text-center">
            {[
              { label: "current", amt: "$1.2k", tone: "bg-emerald-50 text-emerald-700" },
              { label: "1–30", amt: "$1.2k", tone: "bg-amber-50 text-amber-700" },
              { label: "31–60", amt: "—", tone: "bg-zinc-50 text-zinc-400" },
              { label: "61–90", amt: "—", tone: "bg-zinc-50 text-zinc-400" },
              { label: "90+", amt: "—", tone: "bg-zinc-50 text-zinc-400" },
            ].map((b) => (
              <div key={b.label} className={`rounded-lg px-1 py-1.5 ${b.tone}`}>
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
            <span className="text-[12.5px] font-semibold text-zinc-900">
              ACME-CORP-INV-0007
            </span>
            <Tag tone="bg-emerald-50 text-emerald-700 ring-emerald-200">Paid</Tag>
          </div>
          <div className="mt-3 space-y-1.5 text-[12px]">
            <div className="flex justify-between text-zinc-600">
              <span>Pro plan · 12 seats</span>
              <span className="tabular-nums">$1,080.00</span>
            </div>
            <div className="flex justify-between text-zinc-600">
              <span>Priority support</span>
              <span className="tabular-nums">$120.00</span>
            </div>
            <div className="flex justify-between border-t border-zinc-100 pt-1.5 text-zinc-500">
              <span>VAT 20% (exclusive)</span>
              <span className="tabular-nums">$240.00</span>
            </div>
            <div className="flex justify-between text-[13px] font-semibold text-zinc-950">
              <span>Total</span>
              <span className="tabular-nums">$1,440.00</span>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-zinc-400">
            <Landmark className="h-3 w-3" />
            recurring · every month on the 1st · auto-issue + email PDF
          </div>
        </div>
        <div className="p-5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Auto-posted journal entry
          </div>
          <div className="mt-3 space-y-1.5 font-mono text-[11px]">
            {[
              { acct: "1100 Bank", dr: "$1,440.00", cr: "" },
              { acct: "1200 Accounts Receivable", dr: "", cr: "$1,440.00" },
            ].map((l) => (
              <div key={l.acct} className="flex items-center justify-between rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                <span className="text-zinc-700">{l.acct}</span>
                <span className="w-20 text-right tabular-nums text-zinc-900">{l.dr}</span>
                <span className="w-20 text-right tabular-nums text-zinc-500">{l.cr}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Ledger balanced
            </span>
            <span className="font-mono text-[10px] text-zinc-400">
              trial balance ✓ · period open
            </span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-1.5 text-center text-[10px]">
            {["P&L", "Balance sheet", "Cash flow"].map((r) => (
              <span key={r} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 font-medium text-zinc-600">
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
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Repositories
          </div>
          <div className="mt-2 space-y-2">
            {[
              { name: "api-server", grant: "read & push", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
              { name: "marketing-site", grant: "read & push", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
              { name: "infra", grant: "read only", tone: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
            ].map((r) => (
              <div key={r.name} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-700">
                  <GitBranch className="h-3 w-3 text-zinc-400" />
                  {r.name}
                </span>
                <Tag tone={r.tone}>{r.grant}</Tag>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-400">
            <Star className="h-3 w-3" />
            granted to Sam (AI) · SSH deploy key, encrypted
          </div>
        </div>
        <div className="p-4 md:col-span-3">
          <div className="rounded-xl bg-zinc-950 p-4 font-mono text-[11px] leading-5">
            <div className="flex items-center gap-1.5 pb-2 text-[10px] uppercase tracking-widest text-zinc-500">
              <Terminal className="h-3 w-3" />
              sam@genosyn · code-repos/api-server
            </div>
            <div className="text-zinc-400">
              $ git checkout -b fix/rate-limit-headers
            </div>
            <div className="text-zinc-400">$ git commit -m &quot;Return Retry-After on 429s&quot;</div>
            <div className="text-zinc-500">
              [fix/rate-limit-headers 3f2a91c] 2 files changed, 18 insertions(+)
            </div>
            <div className="text-zinc-400">$ git push -u origin fix/rate-limit-headers</div>
            <div className="text-emerald-400">✓ pushed — PR ready for human review</div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-500">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span>
              committed as{" "}
              <span className="font-mono text-[10px] text-zinc-600">
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
