import type { ReactNode } from "react";
import { Logo, LogoMark } from "@/components/Logo";
import { Mark } from "@/components/Marks";
import { StateTag } from "@/sections/Kit";

/**
 * A mock of the product dashboard — Northstar Labs at 09:31 on the Tuesday the
 * board upstairs draws.
 *
 * It is a picture, not a UI: the whole tree is `aria-hidden` behind one
 * `sr-only` sentence, the same way ProductPrototype handles its own chrome.
 * Without that, the invented navigation and copy get read out between the
 * band's real links — and the mock's own landmarks (it used to render a nested
 * `<main>`, which `tests/catalogue.test.ts` now forbids) collide with the
 * page's.
 *
 * Three things changed with the revamp, and the reasons are worth keeping:
 *
 * 1. **It is no longer the hero.** The Board is. A screenshot of a dashboard
 *    is the one asset every competitor also has, so it stopped being the first
 *    claim and became the evidence for a later one: it appears exactly once,
 *    in the product band, mounted on a `Plate` as Fig. 1. Nothing here draws
 *    its own frame, caption or shadow — the plate does that.
 *
 * 2. **The pastels are gone.** It carried emerald, pink, violet and amber
 *    icon tiles, a violet "live" dot and a green health pill, none of which
 *    encoded anything: three different hues meant three different employees,
 *    which is decoration wearing a state machine's clothes. The mock now says
 *    what the rest of the site says — neutral for work that ran, and signal
 *    amber for the two Decisions and one Approval waiting on a person, which
 *    is the only thing on this screen a human has to touch.
 *
 * 3. **It keeps its own miniature type scale**, in `.t-*` faces, rather than
 *    borrowing the marketing ramp. A product UI at 11px is not a section
 *    heading at 40px scaled down, and pretending otherwise is what made the
 *    old mock read as a slide rather than as software. `StateTag` is the one
 *    Kit primitive it does use, because a Decision has to look identical here
 *    and on the board or the vocabulary is not real.
 */

const NAV = [
  { label: "Home", active: true },
  { label: "Workspace" },
  { label: "AI Employees" },
  { label: "Routines" },
  { label: "Tasks" },
  { label: "Revenue" },
  { label: "Finance" },
  { label: "Repositories" },
];

const ROSTER = [
  { initials: "MF", name: "Mira" },
  { initials: "AB", name: "Alex" },
  { initials: "SS", name: "Sam" },
];

/** The amber cell is first because it is the only one that needs a person. */
const STATS = [
  { value: "3", label: "Waiting for you", human: true },
  { value: "18", label: "Runs today", human: false },
  { value: "7", label: "AI Employees", human: false },
  { value: "0", label: "Standdowns", human: false },
];

const RUNS = [
  {
    at: "04:05",
    name: "Mira",
    action: "reconciled 42 Stripe payments",
    meta: "Finance · Complete",
  },
  {
    at: "07:12",
    name: "Alex",
    action: "drafted the launch digest",
    meta: "Marketing · Complete",
  },
  {
    at: "08:15",
    name: "Sam",
    action: "opened a fix for the flaky checkout test",
    meta: "Repositories · Running",
  },
];

/**
 * Two Decisions and one Approval, and the split is not cosmetic. Mira and Sam
 * each stopped and wrote a question with its own options; nothing has happened
 * yet and answering one performs no side effect. Alex already attempted the
 * publish and the system held it, which is why that row is the Approval and
 * why it is the only one phrased as an action rather than a question.
 */
const WAITING = [
  {
    state: "decision" as const,
    word: "Decision",
    at: "10:40",
    title: "Write off a £42 discrepancy, or chase it?",
    meta: "Mira · Finance",
  },
  {
    state: "approval" as const,
    word: "Approval",
    at: "13:10",
    title: "Publish the pricing post",
    meta: "Alex · Marketing",
  },
  {
    state: "decision" as const,
    word: "Decision",
    at: "14:05",
    title: "Rebase the fix, or reopen the issue?",
    meta: "Sam · Repositories",
  },
];

export function CompanyPreview() {
  return (
    <div className="select-none">
      {/* The one sentence a screen reader gets, and it has to describe THIS
          screen. The version it replaces was written for the old mock: it
          announced "scheduled Routines", a panel this no longer draws, and
          folded the two Decisions into "pending approvals" — which is the one
          conflation AGENTS.md §3 exists to prevent. */}
      <span className="sr-only">
        Northstar Labs in Genosyn at 09:31: eighteen Runs finished since midnight, two Decisions and
        one Approval waiting for an answer, and three AI Employees on duty.
      </span>
      <div aria-hidden className="border border-paper-400 bg-paper-50">
        <PreviewHeader />
        <div className="grid min-h-[24rem] md:grid-cols-[12.5rem_minmax(0,1fr)]">
          <PreviewSidebar />
          <PreviewMain />
        </div>
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="flex h-12 items-center gap-2.5 border-b border-paper-400 bg-paper-100 px-3 sm:gap-3 sm:px-4">
      <LogoMark className="h-5 w-5 shrink-0 text-zinc-950 sm:hidden" />
      <Logo className="hidden shrink-0 text-[12px] text-zinc-950 sm:inline-flex" />
      <span className="h-4 w-px shrink-0 bg-paper-300" />
      <span className="t-cond min-w-0 truncate text-[12px] uppercase tracking-field text-zinc-950">
        Northstar Labs
      </span>
      <span className="t-cond hidden text-[12px] uppercase tracking-field text-zinc-600 sm:inline">
        / Home
      </span>
      <span className="t-cond ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[10px] text-paper-50">
        ND
      </span>
    </div>
  );
}

function PreviewSidebar() {
  return (
    <div className="hidden border-r border-paper-400 bg-paper-100 p-3 md:block">
      <div className="t-cond px-1 pb-2 text-[10px] uppercase tracking-field text-zinc-600">
        Company
      </div>

      {NAV.map((item) => (
        <div
          key={item.label}
          className={`t-body -mt-px flex items-center border-y px-2 py-[0.4rem] text-[12px] leading-4 ${
            item.active
              ? "border-zinc-950 bg-zinc-950 text-paper-50"
              : "border-paper-300 text-zinc-700"
          }`}
        >
          {item.label}
        </div>
      ))}

      <div className="t-cond mt-5 px-1 pb-2 text-[10px] uppercase tracking-field text-zinc-600">
        On duty
      </div>
      {ROSTER.map((member) => (
        <div key={member.name} className="flex items-center gap-2 px-1 py-1.5">
          {/* The avatars stay circular. tailwind.config.ts keeps
              `borderRadius.full` for exactly this: the mocks are pictures of a
              real UI and flattening a real circle is a lie about it. */}
          <span className="t-cond flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-200 text-[9px] text-zinc-800 ring-1 ring-inset ring-paper-400">
            {member.initials}
          </span>
          <span className="t-body min-w-0 truncate text-[12px] text-zinc-700">{member.name}</span>
          <Mark state="run" className="ml-auto h-2.5 w-2.5 text-zinc-600" />
        </div>
      ))}
    </div>
  );
}

function PreviewMain() {
  return (
    <div className="min-w-0 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="t-display text-[1.0625rem] leading-tight text-zinc-950">
          Good morning, Nawaz
        </span>
        <span className="t-data text-[11px] leading-4 text-zinc-600">TUE 09:31</span>
      </div>
      <p className="t-body mt-1.5 text-[12px] leading-5 text-zinc-700">
        Eighteen Runs finished before you signed in. Three need an answer.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-px border border-paper-300 bg-paper-300 sm:grid-cols-4">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className={`px-3 py-2.5 ${stat.human ? "bg-signal-500" : "bg-paper-50"}`}
          >
            <div className="tabular t-display text-[19px] leading-none text-zinc-950">
              {stat.value}
            </div>
            <div
              className={`t-cond mt-1.5 text-[10px] uppercase tracking-field ${
                stat.human ? "text-zinc-950" : "text-zinc-600"
              }`}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.05fr_0.95fr]">
        <PreviewPanel title="Runs since 00:00" count="18">
          {RUNS.map((run) => (
            <div
              key={run.at}
              className="-mt-px flex items-start gap-2.5 border-y border-paper-300 py-2.5"
            >
              <span className="t-data w-[3rem] shrink-0 text-[11px] leading-5 text-zinc-600">
                {run.at}
              </span>
              <Mark state="run" className="mt-1.5 h-2.5 w-2.5 shrink-0 text-zinc-600" />
              <span className="min-w-0 flex-1">
                <span className="t-body block text-[12px] leading-5 text-zinc-700">
                  <span className="text-zinc-950">{run.name}</span> {run.action}
                </span>
                <span className="t-cond mt-0.5 block text-[10px] uppercase tracking-field text-zinc-600">
                  {run.meta}
                </span>
              </span>
            </div>
          ))}
        </PreviewPanel>

        <PreviewPanel title="Waiting for you" count="3">
          {WAITING.map((item) => (
            <div key={item.at} className="-mt-px border-y border-paper-300 py-2.5">
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <StateTag state={item.state}>{item.word}</StateTag>
                <span className="t-data text-[11px] leading-4 text-zinc-600">{item.at}</span>
              </span>
              <span className="t-body mt-1.5 block text-[12px] leading-5 text-zinc-800">
                {item.title}
              </span>
              <span className="t-cond mt-0.5 block text-[10px] uppercase tracking-field text-zinc-600">
                {item.meta}
              </span>
            </div>
          ))}
        </PreviewPanel>
      </div>
    </div>
  );
}

function PreviewPanel({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-paper-300 bg-paper-50">
      <div className="flex items-center justify-between gap-3 border-b border-paper-300 px-3 py-2">
        <span className="t-cond text-[10px] uppercase tracking-field text-zinc-950">{title}</span>
        <span className="t-data text-[11px] leading-4 text-zinc-600">{count}</span>
      </div>
      <div className="px-3">{children}</div>
    </div>
  );
}
