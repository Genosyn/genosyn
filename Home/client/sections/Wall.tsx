import { useEffect, useState } from "react";
import { Bell, Building2, LayoutDashboard, ListChecks, UsersRound } from "lucide-react";

type Pane = {
  dept: string;
  hue: string;
  title: string;
  meta: string;
  rows: { left: string; right: string }[];
  arriving: { left: string; right: string };
};

const PANES: Pane[] = [
  {
    dept: "Email",
    hue: "bg-dept-email",
    title: "Inbox",
    meta: "31 answered",
    rows: [
      { left: "Refund for INV-0912", right: "05:51" },
      { left: "Seat count for Q4", right: "05:48" },
      { left: "SSO setup question", right: "05:44" },
      { left: "Invoice copy request", right: "05:39" },
    ],
    arriving: { left: "Renewal date confirmed", right: "05:55" },
  },
  {
    dept: "Finance",
    hue: "bg-dept-finance",
    title: "Ledger",
    meta: "42 reconciled",
    rows: [
      { left: "1100 Bank", right: "£1,440.00" },
      { left: "1200 Accounts Receivable", right: "£1,440.00" },
      { left: "4000 Revenue", right: "£1,200.00" },
      { left: "2200 VAT control", right: "£240.00" },
    ],
    arriving: { left: "Posted · journal balanced", right: "04:45" },
  },
  {
    dept: "Repositories",
    hue: "bg-dept-repositories",
    title: "checkout-api",
    meta: "3 reviewed",
    rows: [
      { left: "fix: flaky checkout test", right: "open" },
      { left: "chore: bump 14 deps", right: "merged" },
      { left: "test: cover refund path", right: "merged" },
      { left: "release Check", right: "green" },
    ],
    arriving: { left: "340 dependencies audited", right: "02:42" },
  },
  {
    dept: "Revenue",
    hue: "bg-dept-revenue",
    title: "Deals",
    meta: "6 Deals moved",
    rows: [
      { left: "Northstar Labs", right: "Proposal" },
      { left: "Vertex Systems", right: "Demo" },
      { left: "Harbour Group", right: "Qualified" },
      { left: "Kestrel AI", right: "Demo" },
    ],
    arriving: { left: "Tuesday Sequence sent", right: "07:00" },
  },
  {
    dept: "Workspace",
    hue: "bg-dept-workspace",
    title: "#operations",
    meta: "14 threads",
    rows: [
      { left: "Mira posted the 09:00 TLDR", right: "08:53" },
      { left: "Sam opened a reliability fix", right: "05:55" },
      { left: "Pax closed 12 tickets", right: "06:27" },
      { left: "Robin booked 3 meetings", right: "09:12" },
    ],
    arriving: { left: "Runs today", right: "19" },
  },
  {
    dept: "Marketing",
    hue: "bg-dept-marketing",
    title: "Launch digest",
    meta: "1 waiting",
    rows: [
      { left: "Pricing post", right: "In review" },
      { left: "Thursday's posts", right: "Scheduled" },
      { left: "Weekly report", right: "Filed" },
      { left: "Changelog draft", right: "In progress" },
    ],
    arriving: { left: "MKT-7 → In review", right: "13:10" },
  },
  {
    dept: "Operations",
    hue: "bg-dept-operations",
    title: "Health",
    meta: "22 probes",
    rows: [
      { left: "app.genosyn.internal", right: "green" },
      { left: "postgres primary", right: "green" },
      { left: "archive → SFTP", right: "green" },
      { left: "queue depth", right: "0" },
    ],
    arriving: { left: "All 22 probes green", right: "07:45" },
  },
];

const TICK = 3400;

export function Wall() {
  const [tick, setTick] = useState(0);
  const [entered, setEntered] = useState(false);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    const done = window.setTimeout(() => setSettled(true), 220 + PANES.length * 55 + 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
  }, []);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % (PANES.length + 1)), TICK);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/5"
    >
      <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            G
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">Northstar Company</p>
            <p className="truncate text-xs text-slate-500">Company dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:block">
            7 AI Employees working
          </span>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500">
            <Bell className="h-4 w-4" />
          </span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            ND
          </span>
        </div>
      </div>

      <div className="sm:grid sm:grid-cols-[10.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-slate-200 bg-white p-3 sm:block">
          <nav className="space-y-1">
            <PreviewNav icon={LayoutDashboard} label="Overview" active />
            <PreviewNav icon={UsersRound} label="AI Employees" />
            <PreviewNav icon={ListChecks} label="Routines" />
            <PreviewNav icon={Building2} label="Company" />
          </nav>
          <div className="mt-6 border-t border-slate-100 pt-4">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Live now
            </p>
            <div className="mt-3 space-y-2.5 px-2">
              {PANES.slice(0, 5).map((pane) => (
                <div key={pane.dept} className="flex items-center gap-2 text-xs text-slate-600">
                  <span className={`h-2 w-2 rounded-full ${pane.hue}`} />
                  <span className="truncate">{pane.dept}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <div className="min-w-0 bg-slate-50 p-2.5 sm:p-3">
          <div className="mb-3 flex items-center justify-between px-1">
            <div>
              <p className="text-sm font-semibold text-slate-900">Today</p>
              <p className="text-xs text-slate-500">Work moving across every department</p>
            </div>
            <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500">
              Live
            </span>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
            {PANES.map((pane, index) => (
              <Surface
                key={pane.dept}
                pane={pane}
                index={index}
                entered={entered}
                settled={settled}
                live={tick === index + 1}
              />
            ))}

            <div className="flex min-h-44 flex-col justify-between gap-6 rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-semibold text-indigo-700">Waiting for you</span>
                <span className="font-mono text-[10px] text-indigo-500">09:30</span>
              </div>
              <div>
                <div className="text-4xl font-semibold tracking-tight text-indigo-950">3</div>
                <p className="mt-2 text-xs leading-5 text-indigo-900/80">
                  Two Decisions and one Approval. Everything else on this wall is finished.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewNav({
  icon: Icon,
  label,
  active = false,
}: {
  icon: typeof LayoutDashboard;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium ${
        active ? "bg-indigo-50 text-indigo-700" : "text-slate-600"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

function Surface({
  pane,
  index,
  entered,
  settled,
  live,
}: {
  pane: Pane;
  index: number;
  entered: boolean;
  settled: boolean;
  live: boolean;
}) {
  const rows = live ? [pane.arriving, ...pane.rows.slice(0, 3)] : pane.rows;

  return (
    <div
      className={`relative min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${
        settled ? "" : "wall-pane"
      }`}
      data-enter={entered || settled ? undefined : "pending"}
      style={settled ? undefined : { transitionDelay: `${index * 55}ms` }}
    >
      <div className="flex items-start justify-between gap-2 px-3.5 pb-2.5 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${pane.hue}`} />
            <span className="truncate text-xs font-semibold text-slate-900">{pane.title}</span>
          </div>
          <span className="mt-1 block truncate pl-4 text-[10px] text-slate-400">{pane.dept}</span>
        </div>
        <span className="shrink-0 font-mono text-[9px] text-slate-400">{pane.meta}</span>
      </div>

      <ul className="px-3.5 pb-3.5">
        {rows.map((row, i) => (
          <li
            key={`${row.left}-${i}`}
            className={`flex items-baseline justify-between gap-2 border-t border-slate-100 py-1.5 ${
              live && i === 0 ? "row-in" : ""
            }`}
          >
            <span className="min-w-0 truncate text-[11px] text-slate-700">{row.left}</span>
            <span className="shrink-0 font-mono text-[9px] text-slate-400">{row.right}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
