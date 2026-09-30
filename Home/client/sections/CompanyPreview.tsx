import type { ReactNode } from "react";
import {
  Building2,
  CalendarClock,
  Check,
  GitBranch,
  Home,
  Landmark,
  ListTodo,
  Mail,
  Megaphone,
  MessageSquare,
  Search,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { LogoMark } from "@/components/Logo";
import { COMPANY, LANES, OVERNIGHT, WAITING, spell } from "@/lib/night";
import { DEPT_DOT, DEPT_LABEL, clock } from "@/sections/Kit";

/**
 * Northstar Labs in Genosyn at 09:31 — the screen a Member signs in to after
 * the night on the rest of the page. A picture of the product, not real UI:
 * the whole thing is aria-hidden behind one sentence that says what it shows.
 */

const NAV: { label: string; icon: LucideIcon; active?: boolean }[] = [
  { label: "Home", icon: Home, active: true },
  { label: "Workspace", icon: MessageSquare },
  { label: "AI Employees", icon: Users },
  { label: "Routines", icon: CalendarClock },
  { label: "Tasks", icon: ListTodo },
  { label: "Email", icon: Mail },
  { label: "Marketing", icon: Megaphone },
  { label: "Revenue", icon: TrendingUp },
  { label: "Customers", icon: Building2 },
  { label: "Finance", icon: Landmark },
  { label: "Repositories", icon: GitBranch },
];

const RECENT = [...OVERNIGHT].reverse().slice(0, 5);

export function CompanyPreview() {
  return (
    <div className="select-none">
      <span className="sr-only">
        {`${COMPANY} in Genosyn at 09:31: ${OVERNIGHT.length} Runs finished overnight, ${WAITING.length} items waiting for a person, and ${LANES.length} AI Employees on the roster.`}
      </span>
      <div aria-hidden className="overflow-hidden bg-white text-[#0E0E0D]">
        {/* Window chrome */}
        <div className="flex h-11 items-center gap-3 border-b border-black/[0.07] bg-[#FAFAF8] px-4">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
            <span className="h-2.5 w-2.5 rounded-full bg-black/10" />
          </span>
          <span className="mx-auto hidden h-6 w-72 items-center justify-center gap-1.5 rounded-md bg-black/[0.04] font-mono text-[10px] text-black/45 sm:flex">
            genosyn / northstar / home
          </span>
        </div>

        <div className="grid min-h-[27rem] md:grid-cols-[12.5rem_minmax(0,1fr)]">
          {/* Sidebar */}
          <div className="hidden border-r border-black/[0.07] bg-[#FAFAF8] p-3 md:block">
            <div className="flex items-center gap-2 px-2 pb-4 pt-1">
              <LogoMark className="h-5 w-5" />
              <span className="truncate text-[12px] font-semibold">{COMPANY}</span>
            </div>
            <div className="space-y-0.5">
              {NAV.map((item) => (
                <div
                  key={item.label}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[11.5px] ${
                    item.active ? "bg-[#0E0E0D] font-medium text-white" : "text-black/60"
                  }`}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                  {item.label}
                </div>
              ))}
            </div>
            <div className="mt-5 border-t border-black/[0.07] px-2 pb-2 pt-4 text-[9.5px] font-medium uppercase tracking-[0.12em] text-black/40">
              On duty
            </div>
            {LANES.slice(0, 4).map((lane) => (
              <div key={lane.person} className="flex items-center gap-2 px-2 py-1.5">
                <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.06] font-mono text-[8px] font-medium">
                  {lane.initials}
                  <span className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-1 ring-[#FAFAF8] ${DEPT_DOT[lane.dept]}`} />
                </span>
                <span className="min-w-0 truncate text-[11px] text-black/60">{lane.person}</span>
                <span className="ml-auto text-[9.5px] text-black/35">{DEPT_LABEL[lane.dept]}</span>
              </div>
            ))}
          </div>

          {/* Home */}
          <div className="min-w-0 bg-white px-4 py-5 sm:px-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[17px] font-semibold tracking-[-0.01em]">Good morning, Dana</p>
                <p className="mt-0.5 text-[11.5px] text-black/50">
                  {`${cap(spell(OVERNIGHT.length))} Runs finished before you signed in. ${cap(spell(WAITING.length))} need an answer.`}
                </p>
              </div>
              <span className="hidden h-7 items-center gap-1.5 rounded-lg border border-black/[0.08] px-2.5 text-[10.5px] text-black/40 sm:flex">
                <Search className="h-3 w-3" /> Search
                <span className="ml-3 font-mono">⌘K</span>
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat value={String(WAITING.length)} label="Waiting for you" solid />
              <Stat value={String(OVERNIGHT.length)} label="Runs since 00:00" />
              <Stat value={String(LANES.length)} label="AI Employees" />
              <Stat value="0" label="Standdowns" />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-[1.08fr_0.92fr]">
              <Panel title="Runs since 00:00" count={String(OVERNIGHT.length)}>
                {RECENT.map((run) => (
                  <div key={`${run.person}-${run.at}`} className="flex items-start gap-2.5 border-t border-black/[0.06] px-3 py-2 first:border-t-0">
                    <span className="w-9 shrink-0 pt-px font-mono text-[9.5px] leading-4 text-black/40">{clock(run.at)}</span>
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#3C8F63]" />
                    <span className="min-w-0 flex-1 text-[11px] leading-4 text-black/70">
                      <span className="font-medium text-black">{run.person}</span> · {run.label}
                    </span>
                  </div>
                ))}
              </Panel>
              <Panel title="Waiting for you" count={String(WAITING.length)}>
                {WAITING.map((item) => (
                  <div key={item.label} className="border-t border-black/[0.06] px-3 py-2.5 first:border-t-0">
                    <span className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] ${
                          item.state === "decision"
                            ? "bg-[#0E0E0D] text-white"
                            : "border border-black/60 text-black"
                        }`}
                      >
                        {item.state}
                      </span>
                      <span className="text-[9.5px] text-black/40">{`${item.person} · ${DEPT_LABEL[item.dept]}`}</span>
                    </span>
                    <span className="mt-1.5 block text-[11.5px] leading-4 text-black">{item.label}</span>
                  </div>
                ))}
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, solid = false }: { value: string; label: string; solid?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${solid ? "border-[#0E0E0D] bg-[#0E0E0D] text-white" : "border-black/[0.08] bg-white"}`}>
      <div className="text-[20px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      <div className={`mt-1.5 text-[9px] font-medium uppercase tracking-[0.1em] ${solid ? "text-white/60" : "text-black/40"}`}>
        {label}
      </div>
    </div>
  );
}

function Panel({ title, count, children }: { title: string; count: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.08] bg-white">
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-[#FAFAF8] px-3 py-2">
        <span className="text-[10.5px] font-semibold">{title}</span>
        <span className="font-mono text-[9.5px] text-black/40">{count}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
