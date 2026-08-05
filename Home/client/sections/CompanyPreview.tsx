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
    color: "bg-emerald-100 text-emerald-700",
    name: "Mira",
    action: "reconciled 42 payments",
    meta: "Finance · 2m ago",
    status: "Complete",
  },
  {
    initials: "AB",
    color: "bg-sky-100 text-sky-700",
    name: "Alex",
    action: "prepared the launch digest",
    meta: "Marketing · 8m ago",
    status: "Review",
  },
  {
    initials: "SS",
    color: "bg-zinc-200 text-zinc-800",
    name: "Sam",
    action: "opened a reliability fix",
    meta: "Code · 14m ago",
    status: "Running",
  },
];

export function CompanyPreview() {
  return (
    <div className="preview-enter relative mx-auto max-w-[84rem] select-none">
      <div
        aria-hidden
        className="absolute -inset-8 -z-10 rounded-[3rem] bg-slate-300/30 blur-3xl"
      />
      <div className="overflow-hidden rounded-2xl border border-slate-300/90 bg-white shadow-[0_38px_90px_-38px_rgba(15,23,42,0.42)] ring-1 ring-white">
        <PreviewHeader />
        <div className="grid min-h-[31rem] md:grid-cols-[12.5rem_minmax(0,1fr)]">
          <PreviewSidebar />
          <PreviewMain />
        </div>
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4">
      <LogoMark className="h-7 w-7 sm:hidden" />
      <Logo className="hidden h-7 w-auto sm:block" />
      <span className="h-5 w-px bg-slate-200" />
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-800">
        <span className="truncate">Northstar Labs</span>
        <ChevronDown className="h-3 w-3 text-slate-400" />
      </span>
      <span className="hidden text-slate-300 sm:inline">/</span>
      <span className="hidden text-xs font-medium text-slate-600 sm:inline">Home</span>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-medium text-slate-400 sm:inline">
          ⌘ K
        </span>
        <span className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500">
          <Bell className="h-3.5 w-3.5" />
        </span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-[9px] font-semibold text-white">
          ND
        </span>
      </div>
    </div>
  );
}

function PreviewSidebar() {
  return (
    <aside className="hidden border-r border-slate-200 bg-slate-50/80 p-3 md:block">
      <div className="px-2 pb-2 pt-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Company
      </div>
      <nav className="space-y-0.5">
        {NAV_ITEMS.map((item) => (
          <div
            key={item.label}
            className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-[11px] font-medium ${
              item.active
                ? "bg-slate-100 text-slate-800 ring-1 ring-inset ring-slate-200"
                : "text-slate-600"
            }`}
          >
            <item.icon className="h-3.5 w-3.5" />
            {item.label}
          </div>
        ))}
      </nav>

      <div className="mt-5 px-2 pb-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        On duty
      </div>
      <div className="space-y-2 px-1">
        {ACTIVITY.slice(0, 3).map((item, index) => (
          <div key={item.name} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-md text-[8px] font-bold ${item.color}`}
            >
              {item.initials}
            </span>
            <span className="text-[10px] font-medium text-slate-600">{item.name}</span>
            <span
              className={`ml-auto h-1.5 w-1.5 rounded-full ${
                index === 2 ? "preview-live bg-slate-900" : "bg-emerald-500"
              }`}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}

function PreviewMain() {
  return (
    <main className="min-w-0 bg-slate-50 px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-lg font-semibold tracking-[-0.02em] text-slate-900">
            Good morning, Nawaz
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            Here&apos;s what needs your attention at Northstar Labs.
          </div>
        </div>
        <div className="inline-flex w-fit items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          All systems healthy
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        <Stat icon={ShieldCheck} value="3" label="Pending approvals" accent="graphite" />
        <Stat icon={Clock3} value="18" label="Routines today" accent="emerald" />
        <Stat icon={ListChecks} value="5" label="Waiting for review" accent="zinc" />
        <Stat icon={Users} value="7" label="AI Employees" accent="sky" />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.08fr_0.92fr]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="text-[11px] font-semibold text-slate-900">AI activity</div>
            <span className="text-[9px] font-medium text-slate-950">View all Runs</span>
          </div>
          <div className="divide-y divide-slate-100 px-4">
            {ACTIVITY.map((item) => (
              <div key={item.name} className="flex items-center gap-3 py-3">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[9px] font-semibold ${item.color}`}
                >
                  {item.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] text-slate-700">
                    <span className="font-semibold text-slate-900">{item.name}</span> {item.action}
                  </span>
                  <span className="mt-0.5 block text-[9px] text-slate-400">{item.meta}</span>
                </span>
                <StatusBadge status={item.status} />
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="text-[11px] font-semibold text-slate-900">Needs your attention</div>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold text-slate-950">
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
              detail="Sam · Code Repositories"
              tone="graphite"
            />
            <AttentionRow
              icon={Sparkles}
              title="Classify one payment"
              detail="Mira · Finance"
              tone="emerald"
            />
          </div>
          <div className="mx-3 mb-3 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[10px] font-medium text-slate-800">
              <Activity className="h-3.5 w-3.5" />
              Work keeps moving. Sensitive changes wait for you.
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Stat({
  icon: Icon,
  value,
  label,
  accent,
}: {
  icon: typeof ShieldCheck;
  value: string;
  label: string;
  accent: "graphite" | "emerald" | "zinc" | "sky";
}) {
  const accents = {
    graphite: "bg-slate-100 text-slate-950",
    emerald: "bg-emerald-50 text-emerald-600",
    zinc: "bg-zinc-100 text-zinc-800",
    sky: "bg-sky-50 text-sky-600",
  };

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${accents[accent]}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span>
        <span className="block text-sm font-semibold tabular text-slate-900">{value}</span>
        <span className="block text-[9px] text-slate-500">{label}</span>
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style =
    status === "Complete"
      ? "bg-emerald-50 text-emerald-700"
      : status === "Review"
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-800";
  return <span className={`rounded-md px-2 py-1 text-[8px] font-semibold ${style}`}>{status}</span>;
}

function AttentionRow({
  icon: Icon,
  title,
  detail,
  tone,
}: {
  icon: typeof ShieldCheck;
  title: string;
  detail: string;
  tone: "amber" | "graphite" | "emerald";
}) {
  const styles = {
    amber: "bg-amber-50 text-amber-600",
    graphite: "bg-slate-100 text-slate-950",
    emerald: "bg-emerald-50 text-emerald-600",
  };
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-slate-100 bg-slate-50/70 p-2.5">
      <span className={`flex h-7 w-7 items-center justify-center rounded-md ${styles[tone]}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[10px] font-medium text-slate-800">{title}</span>
        <span className="mt-0.5 block truncate text-[9px] text-slate-400">{detail}</span>
      </span>
    </div>
  );
}
