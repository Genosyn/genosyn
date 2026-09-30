import type { ReactNode } from "react";
import { Check, CircleDashed, FileText, Lock } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { findRole } from "@/roles/data";
import { Avatar, Container, Em, Section, SectionHead, StateTag, TextLink } from "@/sections/Kit";

/**
 * One AI Employee, printed rather than described: the Bookkeeper's Soul,
 * Skills, the Routine that ran at 04:05 in the hero, and its Grants.
 *
 * The Soul's £25 line is load-bearing. It is why Mira stopped on a £42
 * discrepancy instead of deciding for herself — the Decision waiting in the
 * hero's morning card is a consequence of a sentence the reader can see here.
 */

const SOUL = [
  "Never state a figure I have not matched to a ledger line.",
  "Queue anything I cannot prove, and attach the evidence to it.",
  "Ask before writing off more than £25.",
];

const GRANTS: { kind: string; resource: string; scope: string }[] = [
  { kind: "Connection", resource: "stripe", scope: "read" },
  { kind: "Connection", resource: "gmail:accounts", scope: "send" },
  { kind: "Note", resource: "month-end-pack", scope: "write" },
  { kind: "Repository", resource: "finance-docs", scope: "read" },
];

const RUNS = [
  { day: "Tue", took: "40m", verdict: "green" as const },
  { day: "Mon", took: "38m", verdict: "green" as const },
  { day: "Sun", took: "44m", verdict: "unclear" as const },
];

const LADDER = [
  {
    step: "Ask",
    body: "Ask an AI Employee in a channel or a DM, the way you would ask a colleague. It does the work with the Grants it holds.",
  },
  {
    step: "Write it down",
    body: "When you ask for the same thing twice, it becomes a Skill: a playbook the employee follows every time the work matches.",
  },
  {
    step: "Put it on a schedule",
    body: "A Routine points a schedule at the brief. It fires on time, through the night, and nobody has to remember to ask.",
  },
];

export function Anatomy() {
  const bookkeeper = findRole("bookkeeper");
  const skills = bookkeeper?.skills ?? ["reconcile-payments", "chase-overdue-invoice", "categorise-spend"];
  const grid = useReveal<HTMLDivElement>(0, 80);
  const ladder = useReveal<HTMLOListElement>(0, 80);

  return (
    <Section id="anatomy" space="md">
      <Container>
        <SectionHead
          kicker="Inside a role"
          title={
            <>
              An AI Employee is four documents you can read.
            </>
          }
          lede="Nothing hidden and nothing proprietary. A Soul, its Skills, its Routines and its Grants are plain text on a database row: edited in place, read fresh on every Run."
        />

        <div ref={grid} className="mt-14 grid gap-4 lg:grid-cols-12">
          {/* Soul */}
          <Panel className="lg:col-span-7" label="Soul" caption="Who they are">
            <div className="flex items-center gap-3 border-b border-line px-6 py-4">
              <Avatar initials="MI" dept="finance" size="sm" />
              <p className="text-[13.5px] text-ink-600">
                <span className="font-medium text-ink">Mira</span> · AI Bookkeeper
              </p>
              <span className="ml-auto font-mono text-[11px] text-ink-400">41 lines</span>
            </div>
            <div className="relative px-6 pb-8 pt-6">
              <p className="font-mono text-[12px] text-ink-400"># How I work</p>
              <ul className="mt-3 space-y-3">
                {SOUL.map((line, index) => (
                  <li
                    key={line}
                    className={`text-[1.125rem] font-medium leading-[1.45] tracking-[-0.012em] sm:text-[1.25rem] ${
                      index === SOUL.length - 1 ? "text-ink" : "text-ink-600"
                    }`}
                  >
                    {index === SOUL.length - 1 ? (
                      <mark className="bg-transparent text-ink underline decoration-ink decoration-[1.5px] underline-offset-[6px]">{line}</mark>
                    ) : (
                      line
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-6 flex items-start gap-2 text-[13px] leading-5 text-ink-500">
                <span aria-hidden className="mt-2 h-px w-4 shrink-0 bg-ink" />
                That last line is why Mira stopped on a £42 discrepancy and asked, instead of
                writing it off.
              </p>
            </div>
          </Panel>

          {/* Skills */}
          <Panel className="lg:col-span-5" label="Skills" caption="How they work">
            <ul className="divide-y divide-line px-2 py-2">
              {skills.map((skill) => (
                <li key={skill} className="flex items-center gap-3 px-4 py-3">
                  <FileText aria-hidden className="h-4 w-4 shrink-0 text-ink-400" />
                  <span className="min-w-0 truncate font-mono text-[13px] text-ink">{skill}</span>
                  <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
                    .md
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-6 py-4 text-[13.5px] leading-5 text-ink-500">
              Named playbooks with a trigger, the steps, and a definition of done. The ones that
              match the work load into context on every Run.
            </p>
          </Panel>

          {/* Routine */}
          <Panel className="lg:col-span-5" label="Routines" caption="When they work">
            <div className="px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[16px] font-medium text-ink">Reconcile Stripe payments</p>
                  <p className="mt-1 text-[13.5px] text-ink-500">Every day at 04:05, Europe/London</p>
                </div>
                <span className="shrink-0 rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[13px] text-ink">
                  5 4 * * *
                </span>
              </div>
              <p className="mt-4 text-[14px] leading-6 text-ink-600">
                Match yesterday&rsquo;s payouts against open invoices, then post what is left over to
                the suspense account.
              </p>
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-paper-sunken/70 px-3 py-2.5">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-500">Check</span>
                <code className="font-mono text-[12.5px] text-ink">unmatched_payments == 0</code>
              </div>
            </div>
            <ul className="border-t border-line px-6 py-3">
              {RUNS.map((run) => (
                <li key={run.day} className="flex items-center gap-3 py-1.5 text-[13px]">
                  {run.verdict === "green" ? (
                    <Check aria-hidden className="h-3.5 w-3.5 text-moss-500" />
                  ) : (
                    <CircleDashed aria-hidden className="h-3.5 w-3.5 text-ink" />
                  )}
                  <span className="w-20 font-mono text-[12px] text-ink-500">{`${run.day} 04:05`}</span>
                  <span className="font-mono text-[12px] text-ink-500">{run.took}</span>
                  <span className="text-ink-600">{run.verdict}</span>
                  {run.verdict === "unclear" && (
                    <StateTag state="decision" className="ml-auto">
                      1 Decision
                    </StateTag>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          {/* Grants */}
          <Panel className="lg:col-span-7" label="Grants" caption="What they can reach">
            <table className="w-full text-left">
              <caption className="sr-only">The Bookkeeper&apos;s four Grants</caption>
              <thead>
                <tr className="border-b border-line font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-400">
                  <th scope="col" className="px-6 py-3 font-medium">Resource</th>
                  <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Kind</th>
                  <th scope="col" className="px-6 py-3 text-right font-medium">Scope</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {GRANTS.map((grant) => (
                  <tr key={grant.resource}>
                    <td className="px-6 py-3.5 font-mono text-[13px] text-ink">{grant.resource}</td>
                    <td className="hidden px-3 py-3.5 text-[13.5px] text-ink-500 sm:table-cell">{grant.kind}</td>
                    <td className="px-6 py-3.5 text-right">
                      <span className="rounded-full border border-line bg-paper px-2.5 py-1 font-mono text-[11px] text-ink-600">
                        {grant.scope}
                      </span>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="px-6 py-3.5">
                    <span className="flex items-center gap-2 text-[13.5px] text-ink-500">
                      <Lock aria-hidden className="h-3.5 w-3.5" />
                      Everything else — including the rest of each Integration — is unreachable.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>
        </div>

        {/* The autonomy ladder */}
        <div className="mt-28">
          <div className="grid gap-x-16 gap-y-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end">
            <h3 className="font-display text-display-md text-balance">
              Autonomy is a ladder, <Em tone="muted">not a switch.</Em>
            </h3>
            <div className="lg:pb-1">
              <p className="max-w-[46ch] text-[15.5px] leading-[1.65] text-ink-600">
                Each rung removes one more reason for a person to press start. You decide how far up
                each role climbs.
              </p>
              <TextLink href="/docs/autonomy" className="mt-4">
                How autonomy is earned
              </TextLink>
            </div>
          </div>
          <ol ref={ladder} className="mt-10 grid gap-4 md:grid-cols-3">
            {LADDER.map((rung, index) => (
              <li key={rung.step} className="relative rounded-3xl border border-line bg-paper-raised p-6">
                <span className="font-mono text-[12px] text-ink-400">{`0${index + 1}`}</span>
                <p className="mt-10 font-display text-[1.45rem] leading-tight tracking-[-0.03em] text-ink">{rung.step}</p>
                <p className="mt-3 max-w-[38ch] text-[14.5px] leading-6 text-ink-600">{rung.body}</p>
                {/* Rungs rise left to right. */}
                <span
                  aria-hidden
                  className="absolute right-6 top-6 flex items-end gap-0.5"
                >
                  {[0, 1, 2].map((bar) => (
                    <span
                      key={bar}
                      className={`w-1 rounded-full ${bar <= index ? "bg-ink" : "bg-ink-100"}`}
                      style={{ height: 6 + bar * 5 }}
                    />
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </Section>
  );
}

function Panel({
  label,
  caption,
  className = "",
  children,
}: {
  label: string;
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col overflow-hidden rounded-3xl border border-line bg-paper-raised ${className}`}>
      <div className="flex items-baseline justify-between gap-4 px-6 pt-5">
        <p className="font-display text-[1.35rem] leading-none tracking-[-0.03em] text-ink">{label}</p>
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">{caption}</p>
      </div>
      <div className="mt-4 flex flex-1 flex-col border-t border-line">{children}</div>
    </div>
  );
}
