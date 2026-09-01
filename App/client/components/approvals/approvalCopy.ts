import { Award, Globe, Megaphone, Plug, ShieldCheck, ShieldQuestion, Zap } from "lucide-react";
import type { ApprovalKind } from "@/lib/api";

/**
 * How each kind of approval describes itself, and what approving it will
 * actually do.
 *
 * This is the per-kind rendering contract for every surface that shows an
 * approval — the inbox at `/approvals` and the peek on Home. It lives here
 * rather than in either of them because a gate the two surfaces word
 * differently is a gate somebody approves without knowing what they approved.
 *
 * `consequence` is the sentence the inbox only ever carried as a code comment.
 * A row you skim is one thing; a modal with an Approve button in it is where a
 * person actually decides, so what happens next has to be on screen.
 */

export type ApprovalCopy = {
  title: string;
  subtitle: string;
  /** One line saying what approving does. Shown where the decision is made. */
  consequence: string;
  Icon: typeof ShieldCheck;
  iconClass: string;
};

/**
 * The fields the copy is derived from. Structural on purpose: the full
 * `Approval` from the inbox and the trimmed `HomeApproval` in the Home payload
 * both satisfy it, so neither surface has to refetch to render a row it has.
 */
export type ApprovalCopySource = {
  kind: string;
  title: string | null;
  summary: string | null;
  routine: { name: string } | null;
};

export function approvalCopy(a: ApprovalCopySource): ApprovalCopy {
  switch (a.kind as ApprovalKind) {
    case "lightning_payment":
      return {
        title: a.title ?? "Lightning payment",
        subtitle: a.summary ?? "Send a Lightning payment",
        consequence: "Approving sends the payment. It cannot be recalled.",
        Icon: Zap,
        iconClass: "text-amber-500",
      };
    case "browser_action":
      // Browser actions don't run server-side — the model re-fires via
      // browser_resume once the row flips to approved. The re-fire is
      // bound to the approved page and runs once.
      return {
        title: a.title ?? "Browser submit",
        subtitle: a.summary ?? "AI employee wants to submit a form",
        consequence:
          "Approving lets the employee submit the form it was holding, on that page, once.",
        Icon: Globe,
        iconClass: "text-indigo-500",
      };
    case "mcp_tool":
      return {
        title: a.title ?? "Guarded MCP tool call",
        subtitle: a.summary ?? "AI employee wants to run a guarded tool",
        consequence: "Approving runs the tool call exactly as it was requested.",
        Icon: Plug,
        iconClass: "text-sky-600",
      };
    case "ad_spend":
      return {
        title: a.title ?? "Ad spend change",
        subtitle: a.summary ?? "AI employee wants to change ad spend",
        consequence: "Approving applies the spend change at the ad platform.",
        Icon: Megaphone,
        iconClass: "text-rose-500",
      };
    case "autonomy_promotion":
      // The eligibility sweep's proposal, not the employee's request. The
      // server-set summary is the evidence sentence; approving executes the
      // settings change (an AutonomyWaiver is granted, the gate goes quiet).
      return {
        title: a.title ?? "Autonomy promotion",
        subtitle: a.summary ?? "Earned autonomy — approving switches the named gate off",
        consequence:
          "Approving grants the waiver and switches the named gate off — this employee stops asking.",
        Icon: Award,
        iconClass: "text-emerald-600",
      };
    case "tainted_tool":
      // The turn read web content before a high-risk call, so the call was
      // held (M53b). Approving replays the recorded call verbatim — nothing
      // is re-generated from the tainted context.
      return {
        title: a.title ?? "Held call from a tainted turn",
        subtitle:
          a.summary ??
          "This turn read web content before a high-risk call. Approving replays it verbatim.",
        consequence:
          "Approving replays the recorded call verbatim. Nothing is re-generated from the web content the turn read.",
        Icon: ShieldQuestion,
        iconClass: "text-amber-600",
      };
    case "routine":
    default:
      return {
        title: a.routine?.name ?? "(deleted routine)",
        subtitle: "Run scheduled routine",
        consequence: "Approving starts the run.",
        Icon: ShieldCheck,
        iconClass: "text-amber-600",
      };
  }
}
