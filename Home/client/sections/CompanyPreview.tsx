import {
  Activity,
  Bell,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Home,
  ListChecks,
  Mail,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Logo, LogoMark } from "@/components/Logo";

const NAV_ITEMS = [
  { label: "Home", icon: Home, active: true },
  { label: "Workspace", icon: MessageSquare },
  { label: "AI Employees", icon: Bot },
  { label: "Routines", icon: Clock3 },
  { label: "Tasks", icon: ListChecks },
  { label: "Revenue", icon: CircleDollarSign },
  { label: "Email", icon: Mail },
];

const ACTIVITY = [
  {
    initials: "MF",
    color: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    dot: "bg-emerald-500",
    name: "Mira",
    action: "reconciled 42 payments",
    meta: "Finance · 2m ago",
    status: "Complete",
  },
  {
    initials: "AB",
    color: "bg-pink-100 text-pink-700 ring-pink-200",
    dot: "bg-pink-500",
    name: "Alex",
    action: "prepared the launch digest",
    meta: "Marketing · 8m ago",
    status: "Review",
  },
  {
    initials: "SS",
    color: "bg-violet-100 text-violet-700 ring-violet-200",
    dot: "bg-violet-500",
    name: "Sam",
    action: "opened a reliability fix",
    meta: "Repositories · 14m ago",
    status: "Running",
  },
];

/**
 * A mock of the product dashboard, used as the landing hero's visual. It is a
 * picture, not a UI: the whole tree is `aria-hidden` behind one `sr-only`
 * sentence, the same way ProductPrototype handles its own chrome. Without that
 * the invented navigation and copy get read out between the hero CTAs and the
 * next section — and the mock's own landmarks (it used to render a nested
 * `<main>`) collide with the page's real ones.
 *
 * It renders at the hero's full container width now, so there is no longer a
 * `compact` variant hiding the activity feed.
 */
export function CompanyPreview() {
  return (
    <div className="preview-enter relative mx-auto select-none">
      <span className="sr-only">
        A Genosyn workspace showing pending approvals, scheduled Routines, and the AI Employees on
        duty at an example company.
      </span>
      <div
        aria-hidden
        className="overflow-hidden rounded-2xl border border-stone-900/[0.10] bg-white shadow-raise ring-1 ring-white/80"
      >
        <PreviewHeader />
        <div className="grid min-h-[31rem] md:grid-cols-[13rem_minmax(0,1fr)]">
          <PreviewSidebar />
          <PreviewMain />
        </div>
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-stone-900/[0.08] bg-white px-3 sm:gap-3 sm:px-4">
      <LogoMark className="h-7 w-7 text-stone-900 sm:hidden" />
      <Logo className="hidden h-7 w-auto text-stone-900 sm:block" />
      <span className="h-5 w-px bg-stone-900/10" />
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-stone-800">
        <span className="truncate">Northstar Labs</span>
        <ChevronDown className="h-3 w-3 text-stone-400" />
      </span>
      <span className="hidden text-stone-300 sm:inline">/</span>
      <span className="hidden text-xs font-medium text-stone-500 sm:inline">Home</span>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden rounded border border-stone-900/10 bg-paper-100 px-1.5 py-0.5 font-mono text-[9px] font-medium text-stone-400 sm:inline">
          ⌘ K
        </span>
        <span className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400">
          <Bell className="h-3.5 w-3.5" />
        </span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 text-[9px] font-bold text-white">
          ND
        </span>
      </div>
    </div>
  );
}

function PreviewSidebar() {
  return (
    <div className="hidden border-r border-stone-900/[0.08] bg-paper-100 p-3 md:block">
      <div className="px-2 pb-2 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-stone-400">
        Company
      </div>
      <div className="space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <div
            key={item.label}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[11px] font-medium ${
              item.active
                ? "bg-flame-100 text-flame-700 ring-1 ring-inset ring-flame-200"
                : "text-stone-600"
            }`}
          >
            <item.icon className="h-3.5 w-3.5" />
            {item.label}
          </div>
        ))}
      </div>

      <div className="mt-6 px-2 pb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-stone-400">
        On duty
      </div>
      <div className="space-y-2 px-1">
        {ACTIVITY.map((item, index) => (
          <div key={item.name} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-lg text-[8px] font-bold ring-1 ring-inset ${item.color}`}
            >
              {item.initials}
            </span>
            <span className="text-[10px] font-medium text-stone-600">{item.name}</span>
            <span
              className={`ml-auto h-1.5 w-1.5 rounded-full ${
                index === 2 ? "preview-live bg-flame-500" : "bg-emerald-500"
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewMain() {
  return (
    <div className="min-w-0 bg-paper-100 px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-lg font-semibold tracking-[-0.02em] text-stone-900">
            Good morning, Nawaz
          </div>
          <div className="mt-1 text-[11px] text-stone-500">
            Here&apos;s what needs your attention at Northstar Labs.
          </div>
        </div>
        <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
          <span className="preview-live h-1.5 w-1.5 rounded-full bg-emerald-500" />
          All systems healthy
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        <Stat icon={ShieldCheck} value="3" label="Pending approvals" accent="amber" />
        <Stat icon={Clock3} value="18" label="Routines today" accent="emerald" />
        <Stat icon={ListChecks} value="5" label="Waiting for review" accent="violet" />
        <Stat icon={Users} value="7" label="AI Employees" accent="flame" />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.08fr_0.92fr]">
        <div className="overflow-hidden rounded-xl border border-stone-900/[0.08] bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-stone-900/[0.06] px-4 py-3">
            <div className="text-[11px] font-semibold text-stone-900">AI activity</div>
            <span className="text-[9px] font-semibold text-flame-600">View all Runs</span>
          </div>
          <div className="divide-y divide-stone-900/[0.06] px-4">
            {ACTIVITY.map((item) => (
              <div key={item.name} className="flex items-center gap-3 py-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold ring-1 ring-inset ${item.color}`}
                >
                  {item.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] text-stone-600">
                    <span className="font-semibold text-stone-900">{item.name}</span> {item.action}
                  </span>
                  <span className="mt-0.5 block text-[9px] text-stone-400">{item.meta}</span>
                </span>
                <StatusBadge status={item.status} />
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-900/[0.08] bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-stone-900/[0.06] px-4 py-3">
            <div className="text-[11px] font-semibold text-stone-900">Needs your attention</div>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700">
              3 items
            </span>
          </div>
          <div className="space-y-2.5 p-3">
            <AttentionRow
              icon={ShieldCheck}
              title="Approve campaign budget"
              detail="Alex · Paid Marketing"
              tone="amber"
            />
            <AttentionRow
              icon={CheckCircle2}
              title="Review checkout patch"
              detail="Sam · Repositories"
              tone="violet"
            />
            <AttentionRow
              icon={Sparkles}
              title="Classify one payment"
              detail="Mira · Finance"
              tone="emerald"
            />
          </div>
          <div className="mx-3 mb-3 rounded-lg border border-flame-200 bg-flame-50 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-semibold text-flame-700">
              <Activity className="h-3.5 w-3.5" />
              Work keeps moving. Sensitive changes wait for you.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STAT_ACCENTS = {
  amber: "bg-amber-100 text-amber-700 ring-amber-200",
  emerald: "bg-emerald-100 text-emerald-700 ring-emerald-200",
  violet: "bg-violet-100 text-violet-700 ring-violet-200",
  flame: "bg-flame-100 text-flame-700 ring-flame-200",
} as const;

function Stat({
  icon: Icon,
  value,
  label,
  accent,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  accent: keyof typeof STAT_ACCENTS;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-stone-900/[0.08] bg-white px-3 py-2.5 shadow-card">
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset ${STAT_ACCENTS[accent]}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span>
        <span className="tabular block text-sm font-bold text-stone-900">{value}</span>
        <span className="block text-[9px] text-stone-500">{label}</span>
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style =
    status === "Complete"
      ? "bg-emerald-100 text-emerald-700"
      : status === "Review"
        ? "bg-amber-100 text-amber-700"
        : "bg-violet-100 text-violet-700";
  return <span className={`rounded-md px-2 py-1 text-[8px] font-bold ${style}`}>{status}</span>;
}

const ATTENTION_TONES = {
  amber: "bg-amber-100 text-amber-700 ring-amber-200",
  violet: "bg-violet-100 text-violet-700 ring-violet-200",
  emerald: "bg-emerald-100 text-emerald-700 ring-emerald-200",
} as const;

function AttentionRow({
  icon: Icon,
  title,
  detail,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  tone: keyof typeof ATTENTION_TONES;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-stone-900/[0.06] bg-paper-100 p-2.5">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset ${ATTENTION_TONES[tone]}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[10px] font-semibold text-stone-800">{title}</span>
        <span className="mt-0.5 block truncate text-[9px] text-stone-400">{detail}</span>
      </span>
    </div>
  );
}
