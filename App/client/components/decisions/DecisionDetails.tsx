import React from "react";
import { parseDecisionContext } from "../../../shared/decisionContext";
import type { Company, Decision } from "@/lib/api";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { DecisionContextSections } from "@/components/decisions/DecisionContext";
import { DecisionPickup } from "@/components/decisions/DecisionPickup";
import { DecisionSourceLine } from "@/components/decisions/DecisionSource";
import { DetailSection, DetailsPanel } from "@/components/decisions/StackRow";
import { answeredBy } from "@/components/decisions/stackStatus";
import { formatRelative } from "@/components/decisions/relative";

/**
 * Everything about a Decision beyond the lines its row shows: the answer and
 * what happened next (once answered), why it needs a person, the employee's
 * longer context, what each choice means, and where it was asked from. One
 * disclosure holds all of it, so the stack itself stays a short list.
 */
export function DecisionDetails({
  id,
  company,
  decision,
  viewerId,
}: {
  id: string;
  company: Company;
  decision: Decision;
  viewerId?: string | null;
}) {
  const context = React.useMemo(() => parseDecisionContext(decision.body), [decision.body]);
  const employee = decision.employee?.name ?? "the AI Employee";
  const explained = decision.options.filter((option) => option.detail);
  const by = answeredBy(decision, viewerId);
  return (
    <DetailsPanel id={id}>
      {decision.status === "decided" && (
        <DetailSection title="Answer">
          <p>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {decision.chosenOptionLabel ?? "Answer recorded"}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              {" — "}
              {by === "You" ? "you" : by === "Someone" ? "someone" : by}
              {decision.decidedAt ? `, ${formatRelative(decision.decidedAt)}` : ""}
            </span>
          </p>
          {decision.note && (
            <p className="mt-1 text-slate-600 dark:text-slate-300">
              <span className="font-medium text-slate-700 dark:text-slate-200">Guidance:</span>{" "}
              {decision.note}
            </p>
          )}
        </DetailSection>
      )}
      {decision.status === "cancelled" && decision.note && (
        <DetailSection title="Reason">
          <p>{decision.note}</p>
        </DetailSection>
      )}
      {decision.status === "decided" && decision.pickupStatus !== "none" && (
        <DetailSection title="What happened next">
          <DecisionPickup decision={decision} />
        </DetailSection>
      )}
      {context.reason && (
        <DetailSection title="Why it needs you">
          <ChatMarkdown content={context.reason} />
        </DetailSection>
      )}
      {context.sections.length > 0 && (
        <DetailSection title="Background">
          <DecisionContextSections sections={context.sections} heading="Background" />
        </DetailSection>
      )}
      {!context.reason && context.sections.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No more detail was included. Use Discuss to ask {employee}.
        </p>
      )}
      {explained.length > 0 && (
        <DetailSection title="The choices">
          <ul className="space-y-1.5">
            {decision.options.map((option) => (
              <li key={option.id} className="min-w-0">
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {option.label}
                </span>
                {option.tone === "primary" && (
                  <span className="ml-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                    Recommended
                  </span>
                )}
                {option.detail && (
                  <span className="text-slate-600 dark:text-slate-300"> — {option.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
      <DetailSection title="Asked from">
        <DecisionSourceLine company={company} decision={decision} />
        {decision.routedToEmployee && decision.status === "pending" && (
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            Routed to {decision.routedToEmployee.name} (AI) to answer first.
          </p>
        )}
      </DetailSection>
    </DetailsPanel>
  );
}
