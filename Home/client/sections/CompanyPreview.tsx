import type { ReactNode } from "react";
import { Logo, LogoMark } from "@/components/Logo";
import { Mark } from "@/components/Marks";
import type { Dept } from "@/sections/Kit";
import { DEPT_FULL, StateTag } from "@/sections/Kit";

/**
 * A mock of the product dashboard — Northstar Labs at 09:31 on the Tuesday the
 * board upstairs draws.
 *
 * It is a picture, not a UI: the whole tree is `aria-hidden` behind one
 * `sr-only` sentence, the same way ProductPrototype handles its own chrome.
 * Without that, the invented navigation and copy get read out between the
 * band's real links — and the mock's own landmarks collide with the page's.
 * It also renders no <main> of its own; `tests/catalogue.test.ts` asserts that
 * (it strips comments first, so this line is safe), because a second one
 * inside the page's own is an HTML conformance error and leaves a screen
 * reader two "main" regions to choose between.
 *
 * ## What this had to stop being
 *
 * It once carried emerald, pink, violet and amber icon tiles, a violet "live"
 * dot and a green health pill: three hues meaning three different employees,
 * which is decoration wearing a state machine's clothes. The pass that removed
 * them went too far the other way and left the whole screen grey, which is a
 * different lie — real software is not monochrome, and a dashboard with no
 * colour in it cannot be the evidence for a page whose argument is that colour
 * is the org chart.
 *
 * So it is coloured again, but only by the legend:
 *
 * - **The sidebar is the org chart.** Every section carries the 3px spine of
 *   the department that owns it, and all seven appear, so the sidebar doubles
 *   as the key for the wall in the hero.
 * - **Every Run wears its department.** The spine on an activity row is the
 *   same hue as the sidebar section the work happened in — which is what makes
 *   a reader able to see, without reading a word, that the night was spread
 *   across four departments.
 * - **Everything waiting for a person is ink.** The stat cell, the panel that
 *   holds the two Decisions and the Approval, and the spine on each of those
 *   rows. On a screen with seven hues on it the eye finds one black column,
 *   and it is the reader's own work.
 *
 * It keeps its own miniature type scale, in `.t-*` faces, rather than
 * borrowing the marketing ramp. A product UI at 11px is not a section heading
 * at 40px scaled down, and pretending otherwise is what made the old mock read
 * as a slide rather than as software. `StateTag` is the one Kit primitive it
 * borrows whole, because a Decision has to look identical here and on the
 * board or the vocabulary is not real.
 *
 * Nothing here draws its own frame, caption or shadow — Features mounts it on
 * a `Plate` as Fig. 7, and the plate does that.
 */

/**
 * The sidebar, and it is the legend.
 *
 * All seven departments appear exactly once as a hue, which is why Email and
 * Paid Marketing are in this list even though the old mock omitted them: three
 * of the rows below are marketing work, and a sidebar that cannot account for
 * them is a sidebar drawn from memory. Home has no department because it is
 * the reader's own page, so its spine is the ink one.
 */
const NAV: { label: string; dept?: Dept; active?: boolean }[] = [
  { label: "Home", active: true },
  { label: "Workspace", dept: "workspace" },
  { label: "AI Employees", dept: "operations" },
  { label: "Routines", dept: "operations" },
  { label: "Tasks", dept: "workspace" },
  { label: "Email", dept: "email" },
  { label: "Marketing", dept: "marketing" },
  { label: "Revenue", dept: "revenue" },
  { label: "Finance", dept: "finance" },
  { label: "Repositories", dept: "repositories" },
];

/**
 * On duty, each in the department its Runs below belong to. The dot is the one
 * place a hue is allowed to be small: `borderRadius.full` survives in
 * tailwind.config.ts for avatars and status dots, and this is the second of
 * those.
 */
const ROSTER: { initials: string; name: string; dept: Dept }[] = [
  { initials: "MF", name: "Mira", dept: "finance" },
  { initials: "AB", name: "Alex", dept: "marketing" },
  { initials: "SS", name: "Sam", dept: "repositories" },
];

/** The ink cell is first because it is the only one that needs a person. */
const STATS = [
  { value: "3", label: "Waiting for you", human: true },
  { value: "18", label: "Runs today", human: false },
  { value: "7", label: "AI Employees", human: false },
  { value: "0", label: "Standdowns", human: false },
];

const RUNS: { at: string; name: string; action: string; meta: string; dept: Dept }[] = [
  {
    at: "04:05",
    name: "Mira",
    action: "reconciled 42 Stripe payments",
    meta: "Finance · Complete",
    dept: "finance",
  },
  {
    at: "07:12",
    name: "Alex",
    action: "drafted the launch digest",
    meta: "Marketing · Complete",
    dept: "marketing",
  },
  {
    at: "08:15",
    name: "Sam",
    action: "opened a fix for the flaky checkout test",
    meta: "Repositories · Running",
    dept: "repositories",
  },
];

/**
 * Two Decisions and one Approval, and the split is not cosmetic. Mira and Sam
 * each stopped and wrote a question with its own options; nothing has happened
 * yet and answering one performs no side effect. Alex already attempted the
 * publish and the system held it, which is why that row is the Approval and
 * why it is the only one phrased as an action rather than a question.
 *
 * These rows carry no department hue even though every one of them came out of
 * a department. That is the inversion, and it is the reason the file is worth
 * looking at twice: the moment work needs a person it stops belonging to
 * Finance or Marketing and starts belonging to you, so it goes black.
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
      {/* No frame of its own. `Plate` already draws one hairline box around
          this, and a `rule`-weight border here sat immediately inside it — two
          1px edges in two different neutrals reading as one 2px frame, which
          is the exact thing the "depth is a 1px seam" rule forbids. Fig. 8 in
          CliShowcase is mounted on a hairline `Pane` for the same reason, so
          the page's two figures now have identical edges. */}
      <div aria-hidden className="bg-surface">
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
    <div className="flex h-12 items-center gap-2.5 border-b border-rule bg-ground px-3 sm:gap-3 sm:px-4">
      <LogoMark className="h-5 w-5 shrink-0 text-ink sm:hidden" />
      <Logo className="hidden shrink-0 text-[12px] text-ink sm:inline-flex" />
      <span className="h-4 w-px shrink-0 bg-hairline" />
      <span className="t-field min-w-0 truncate text-[12px] uppercase text-ink">
        Northstar Labs
      </span>
      <span className="t-field hidden text-[12px] uppercase text-muted sm:inline">/ Home</span>
      {/* The signed-in human, in ink, in the corner every product puts them
          in. It is the same value as the Decision tags below and that is not a
          coincidence: this avatar and those three rows are the same person. */}
      <span className="t-field ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[10px] text-ground">
        ND
      </span>
    </div>
  );
}

function PreviewSidebar() {
  return (
    <div className="hidden border-r border-rule bg-ground p-3 md:block">
      <div className="t-field px-1 pb-2 text-[10px] uppercase text-muted">Company</div>

      {NAV.map((item) => (
        <div
          key={item.label}
          className={`relative -mt-px flex items-center border-y border-hairline py-[0.4rem] pr-2 pl-3 text-[12px] leading-4 ${
            item.active ? "bg-surface font-medium text-ink" : "text-ink2"
          }`}
        >
          {/* The selected row is a white fill and an ink spine, not an ink
              fill. An ink-filled nav item would put a second solid black
              object on the screen competing with the one that means "this needs you" — navigation chrome is not a human state, and the
              inversion only reads if exactly one thing is black. */}
          <span
            className={`absolute inset-y-0 left-0 w-[3px] ${
              item.dept ? DEPT_FULL[item.dept] : "bg-ink"
            }`}
          />
          {item.label}
        </div>
      ))}

      <div className="t-field mt-5 px-1 pb-2 text-[10px] uppercase text-muted">On duty</div>
      {ROSTER.map((member) => (
        <div key={member.name} className="flex items-center gap-2 px-1 py-1.5">
          {/* The avatars stay circular. tailwind.config.ts keeps
              `borderRadius.full` for exactly this: the mocks are pictures of a
              real UI and flattening a real circle is a lie about it. They stay
              neutral, too — an employee is not a department, it works in one,
              and the dot on the right is where that is said. */}
          <span className="t-field flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ground text-[9px] text-ink2 ring-1 ring-inset ring-rule">
            {member.initials}
          </span>
          <span className="min-w-0 truncate text-[12px] text-ink2">{member.name}</span>
          <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${DEPT_FULL[member.dept]}`} />
        </div>
      ))}
    </div>
  );
}

function PreviewMain() {
  return (
    <div className="min-w-0 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="t-h2 text-[1.0625rem] leading-tight text-ink">Good morning, Nawaz</span>
        <span className="t-data text-[11px] leading-4 text-muted">TUE 09:31</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-5 text-ink2">
        Eighteen Runs finished before you signed in. Three need an answer.
      </p>

      {/* Four cells meeting on 1px seams rather than four bordered boxes with
          air between them, which is the same rule the wall upstairs is built
          on. The first cell is inverted, so the count a reader is meant to
          leave with is the one thing here drawn in black. */}
      <div className="mt-4 grid grid-cols-2 gap-px border border-hairline bg-hairline sm:grid-cols-4">
        {STATS.map((stat) => (
          <div key={stat.label} className={`px-3 py-2.5 ${stat.human ? "bg-ink" : "bg-surface"}`}>
            <div
              className={`tabular t-h2 text-[19px] leading-none ${
                stat.human ? "text-ground" : "text-ink"
              }`}
            >
              {stat.value}
            </div>
            <div
              className={`t-field mt-1.5 text-[10px] uppercase ${
                stat.human ? "text-ground/80" : "text-muted"
              }`}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.05fr_0.95fr]">
        {/* The Runs panel takes no edge of its own: the night was four
            departments at once and picking one for the header would be a
            claim the rows underneath contradict. The rows carry the colour. */}
        <PreviewPanel title="Runs since 00:00" count="18">
          {RUNS.map((run) => (
            <div
              key={run.at}
              className="relative -mt-px flex items-start gap-2.5 border-y border-hairline px-3 py-2.5"
            >
              <span className={`absolute inset-y-0 left-0 w-[3px] ${DEPT_FULL[run.dept]}`} />
              <span className="t-data w-[3rem] shrink-0 text-[11px] leading-5 text-muted">
                {run.at}
              </span>
              <Mark state="run" className="mt-1.5 h-2.5 w-2.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] leading-5 text-ink2">
                  <span className="text-ink">{run.name}</span> {run.action}
                </span>
                <span className="t-field mt-0.5 block text-[10px] uppercase text-muted">
                  {run.meta}
                </span>
              </span>
            </div>
          ))}
        </PreviewPanel>

        <PreviewPanel title="Waiting for you" count="3" human>
          {WAITING.map((item) => (
            <div key={item.at} className="relative -mt-px border-y border-hairline px-3 py-2.5">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <StateTag state={item.state}>{item.word}</StateTag>
                <span className="t-data text-[11px] leading-4 text-muted">{item.at}</span>
              </span>
              <span className="mt-1.5 block text-[12px] leading-5 text-ink2">{item.title}</span>
              <span className="t-field mt-0.5 block text-[10px] uppercase text-muted">
                {item.meta}
              </span>
            </div>
          ))}
        </PreviewPanel>
      </div>
    </div>
  );
}

/**
 * A panel inside the mock. `human` inverts its header, which is the same move
 * `StateTag` makes and for the same reason: the panel holding the Decisions
 * and the Approval belongs to the person reading, not to a department, so it
 * is the one panel on the screen with a black bar across the top.
 */
function PreviewPanel({
  title,
  count,
  human = false,
  children,
}: {
  title: string;
  count: string;
  human?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="border border-hairline bg-surface">
      <div
        className={`flex items-center justify-between gap-3 border-b px-3 py-2 ${
          human ? "border-ink bg-ink" : "border-hairline"
        }`}
      >
        <span className={`t-field text-[10px] uppercase ${human ? "text-ground" : "text-ink"}`}>
          {title}
        </span>
        <span className={`t-data text-[11px] leading-4 ${human ? "text-ground/80" : "text-muted"}`}>
          {count}
        </span>
      </div>
      {/* No padding here: the rows carry their own, so a row's department
          spine lands flush against the panel's border instead of floating
          three pixels inside it. */}
      <div>{children}</div>
    </div>
  );
}
