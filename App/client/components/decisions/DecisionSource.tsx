import React from "react";
import { Link } from "react-router-dom";
import { CalendarClock, HelpCircle, Mail, MessageSquare, Repeat } from "lucide-react";
import { Company, Decision, DecisionSource } from "../../lib/api";
import { clsx } from "../ui/clsx";

/**
 * "Where did this come from?" — the single most-asked question about a row in
 * the Decision Stack.
 *
 * A question with no provenance is one you cannot judge: "Send the pricing
 * reply to Acme?" means something different when it came out of the nightly
 * outreach routine than when it came out of a chat you had five minutes ago.
 * So every row says which surface it came from and links straight to it.
 *
 * Deleted things degrade to plain text rather than a dead link: a routine that
 * was removed after the question was asked still tells you it *was* a routine,
 * which is the part that changes how you read the question.
 */

type Chip = {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  /** Undefined renders the chip as text — the target no longer exists. */
  to?: string;
  title?: string;
};

function sourceChips(source: DecisionSource, company: Company): Chip[] {
  const slug = company.slug;
  switch (source.kind) {
    case "routine": {
      const routine = source.routine;
      const chips: Chip[] = [
        {
          icon: Repeat,
          label: routine ? routine.name : "a deleted routine",
          to:
            routine && routine.employeeSlug
              ? `/c/${slug}/routines/${routine.employeeSlug}/${routine.slug}`
              : undefined,
          title: "The routine that was running when this was asked",
        },
      ];
      if (source.run) {
        chips.push({
          icon: CalendarClock,
          label: "the run",
          to:
            routine && routine.employeeSlug
              ? `/c/${slug}/routines/${routine.employeeSlug}/${routine.slug}?run=${source.run.id}`
              : undefined,
          title: `Run ${source.run.status} · triggered by ${source.run.triggerKind}`,
        });
      }
      return chips;
    }
    case "mail":
      return [
        {
          icon: Mail,
          label: source.mailThread?.subject || "an email thread",
          to: source.mailThread ? `/c/${slug}/mail/t/${source.mailThread.id}` : undefined,
          title: "The email this question is about",
        },
      ];
    case "chat":
      return [
        {
          icon: MessageSquare,
          label: source.conversation?.title || "a chat",
          to: undefined,
          title: "The chat this question came out of",
        },
      ];
    case "unknown":
      return [
        {
          icon: HelpCircle,
          label: "asked directly",
          title: "This question was not raised from a routine, an email, or a chat",
        },
      ];
  }
}

const KIND_LABEL: Record<DecisionSource["kind"], string> = {
  routine: "Routine",
  mail: "Email",
  chat: "Chat",
  unknown: "Source",
};

export function DecisionSourceLine({
  company,
  decision,
  className,
}: {
  company: Company;
  decision: Decision;
  className?: string;
}) {
  const source = decision.source;
  // The chat chip can only be linked once we know which employee's chat page to
  // open — the conversation id alone is not addressable.
  const chips = sourceChips(source, company).map((chip) =>
    source.kind === "chat" && decision.employee
      ? {
          ...chip,
          to: `/c/${company.slug}/employees/${decision.employee.slug}/chat${
            source.conversation ? `?conversation=${source.conversation.id}` : ""
          }`,
        }
      : chip,
  );

  return (
    <div className={clsx("flex flex-wrap items-center gap-1 text-[11px]", className)}>
      <span className="text-slate-400 dark:text-slate-500">{KIND_LABEL[source.kind]}</span>
      {chips.map((chip, index) => {
        const Icon = chip.icon;
        const inner = (
          <>
            <Icon size={11} className="shrink-0" />
            <span className="max-w-[18rem] truncate">{chip.label}</span>
          </>
        );
        return (
          <React.Fragment key={`${chip.label}-${index}`}>
            {chip.to ? (
              <Link
                to={chip.to}
                title={chip.title}
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600 transition hover:bg-slate-200 hover:text-slate-900 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100"
              >
                {inner}
              </Link>
            ) : (
              <span
                title={chip.title}
                className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {inner}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
