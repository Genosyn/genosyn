import React from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Company } from "../../lib/api";
import { Button } from "../../components/ui/Button";
import { AccentTile, Note, StepCard, StepFooter } from "./OnboardingFrame";

/**
 * The step that explains the product before asking anyone to configure it.
 *
 * Every term the rest of the guide leans on — AI Employee, Soul, Skill,
 * Routine, Run, Connection, Grant, AI Model — is defined here, at first use.
 * Genosyn's own docs explain all of this well; the running app used to never
 * say any of it, so a first-time member reached the end of setup without a
 * mental model of what they had just built.
 *
 * The two things a member is most likely to be surprised by later — that they
 * bring and pay for their own AI Model, and that Routines act on a schedule
 * once added — are stated here rather than discovered.
 */

const PRIMITIVES: Array<{ icon: LucideIcon; term: string; body: string }> = [
  {
    icon: ScrollText,
    term: "Soul",
    body: "Their written constitution: values, voice, how they make decisions, and what they refuse to do. One markdown document you can read and edit at any time.",
  },
  {
    icon: BookOpen,
    term: "Skills",
    body: "Markdown playbooks — one per piece of work they know how to do, like triaging an inbox, researching a prospect, or preparing a meeting.",
  },
  {
    icon: CalendarClock,
    term: "Routines",
    body: "Work that runs on a schedule instead of waiting to be asked. Each time one fires it becomes a Run — a transcript you can read line by line.",
  },
];

const DAY: string[] = [
  "A Routine comes due on its schedule — say 7:00 AM on weekdays.",
  "The AI Employee reads its Soul and the Skills for that job, so it works the way you wrote down.",
  "It does the work, using only the Connections you granted it — a mailbox, a repository, a database.",
  "It writes up the Run. You read what happened — and if you gated that Routine, it waits for your approval before acting.",
];

// One entry per rail step after this one, in the order the member meets them.
const NEXT_STEPS: Array<{ label: string; body: string }> = [
  {
    label: "Hire one, and connect an AI Model",
    body: "Pick a role. The template arrives with a Soul and Skills already written, and some roles bring starter Routines too. Then register the key they think with — nothing works until one is connected.",
  },
  {
    label: "Review their launch plan",
    body: "Recurring work suggested for the role, and the Connections that make it useful.",
  },
  {
    label: "Connect email",
    body: "Optional. Any mailbox that speaks IMAP. Lets them triage your inbox and draft replies — you still press send.",
  },
  {
    label: "Give them a first request",
    body: "One concrete piece of work, so you can watch how they work before trusting them with a schedule.",
  },
];

export function IntroStep({ company, onContinue }: { company: Company; onContinue: () => void }) {
  return (
    <div className="space-y-4">
      <StepCard>
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600 dark:text-indigo-300">
          What you are setting up
        </div>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
          {company.name} is about to hire its first AI Employee
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          Genosyn runs a company with <strong className="font-semibold">AI Employees</strong> working
          alongside your team. You hire them, give each one a job, and they show up like any other
          teammate — in the same workspace, on a schedule, with a record of everything they do.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          An AI Employee is not a chatbot you have to babysit. Each one is a persistent teammate
          built from three pieces of writing you own and can change:
        </p>

        <dl className="mt-5 space-y-3">
          {PRIMITIVES.map((item) => (
            <div
              key={item.term}
              className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-800/30"
            >
              <AccentTile icon={item.icon} size="sm" />
              <div className="min-w-0">
                <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.term}
                </dt>
                <dd className="mt-0.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {item.body}
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </StepCard>

      {/* Before the day-in-the-life, because that list leans on Connection and
        Grant — and because the AI Model cost is the thing a member should be
        told rather than discover two screens later. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Note kind="warn" icon={CircleDollarSign} title="You bring the AI Model">
          Genosyn does not include one. Each AI Employee runs on an{" "}
          <strong className="font-semibold">AI Model</strong> you register — an Anthropic or OpenAI
          API key, billed by them and not by Genosyn, or any OpenAI-compatible endpoint you point it
          at. You will connect one in the next step, so it is worth having a key ready.
        </Note>
        <Note kind="info" icon={ShieldCheck} title="You stay in control">
          An AI Employee can only reach what you hand it. A{" "}
          <strong className="font-semibold">Connection</strong> is one account your company has
          linked; a <strong className="font-semibold">Grant</strong> is one employee&apos;s access to
          one Connection. Email starts at draft-only — they can triage and write replies, you press
          send. You can also gate any Routine so a human approves it before it acts.
        </Note>
      </div>

      <StepCard>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          How a working day goes
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          The same loop every time, whether the work was scheduled or you asked for it in chat.
        </p>
        <ol className="mt-5 space-y-4">
          {DAY.map((line, index) => (
            <li key={line} className="relative flex gap-3.5 pb-1 last:pb-0">
              {index < DAY.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute left-[13px] top-7 h-[calc(100%-1rem)] w-px bg-slate-200 dark:bg-slate-700"
                />
              )}
              <span className="relative z-10 grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-[11px] font-semibold tabular-nums text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                {index + 1}
              </span>
              <span className="pt-0.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {line}
              </span>
            </li>
          ))}
        </ol>
      </StepCard>

      <StepCard>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          What happens in this guide
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
          Four more steps, about five minutes. You can leave at any point and pick it back up from
          Home.
        </p>
        <ol className="mt-4 space-y-2.5">
          {NEXT_STEPS.map((item, index) => (
            <li key={item.label} className="flex items-start gap-3">
              <CheckCircle2
                size={16}
                className="mt-0.5 shrink-0 text-slate-300 dark:text-slate-600"
                aria-hidden="true"
              />
              <span className="text-sm leading-6">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {index + 1}. {item.label}
                </span>{" "}
                <span className="text-slate-500 dark:text-slate-400">{item.body}</span>
              </span>
            </li>
          ))}
        </ol>

        <StepFooter>
          <Button className="w-full sm:w-auto" onClick={onContinue}>
            Hire my first AI Employee <ArrowRight size={15} />
          </Button>
        </StepFooter>
      </StepCard>
    </div>
  );
}
