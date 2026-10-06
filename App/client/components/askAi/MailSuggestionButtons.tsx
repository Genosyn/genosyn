import React from "react";
import {
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ExternalLink,
  Inbox,
  Reply,
  Send,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import type { Company } from "@/lib/api";
import { askAiApi, type AskAiMessage } from "@/lib/askAi";
import { mailApi, type ComposeInput, type MailSuggestion } from "@/lib/mail";
import { useDialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";

/**
 * One-click next steps an AI Employee staged with `suggest_mail_actions` while
 * it could read an email. The employee proposes; the Member runs each button
 * with their own authority through the ordinary Email routes. Consuming
 * actions (send, triage, hand over, create a rule) are stamped server-side so
 * a reload cannot re-arm them; opening a composer or a thread stays repeatable.
 */

const SUGGESTION_ICONS: Record<MailSuggestion["kind"], React.ReactNode> = {
  reply: <Reply size={12} />,
  send_draft: <Send size={12} />,
  thread_action: <Tag size={12} />,
  open_thread: <ExternalLink size={12} />,
  hand_over: <Bot size={12} />,
  create_rule: <SlidersHorizontal size={12} />,
};

function iconForSuggestion(s: MailSuggestion): React.ReactNode {
  if (s.kind === "thread_action") {
    switch (s.action) {
      case "archive":
        return <Archive size={12} />;
      case "star":
      case "unstar":
        return <Star size={12} />;
      case "trash":
        return <Trash2 size={12} />;
      case "moveToInbox":
        return <Inbox size={12} />;
      default:
        return <Tag size={12} />;
    }
  }
  return SUGGESTION_ICONS[s.kind] ?? <ArrowUpRight size={12} />;
}

/** Server-verified facts under the model-written label — what the Member approves. */
export function verifiedTarget(s: MailSuggestion): string | null {
  switch (s.kind) {
    case "send_draft":
      return s.targetTo ? `to ${s.targetTo}` : null;
    case "thread_action":
    case "open_thread":
      return s.targetSubject ? `"${s.targetSubject}"` : null;
    case "hand_over":
      return s.targetEmployeeName
        ? `${s.targetEmployeeName}${s.targetSubject ? ` · "${s.targetSubject}"` : ""}`
        : null;
    case "reply":
      return s.targetSubject ? `"${s.targetSubject}"` : null;
    default:
      return null;
  }
}

export function suggestionHint(s: MailSuggestion): string {
  switch (s.kind) {
    case "reply":
      return "Opens the composer pre-filled — nothing sends until you do";
    case "send_draft":
      return "Sends the draft immediately";
    case "thread_action":
      return "Applies the triage action to the thread";
    case "open_thread":
      return "Opens the thread";
    case "hand_over":
      return "Hands the thread to an AI employee";
    case "create_rule":
      return "Creates the inbox rule";
    default:
      return s.label;
  }
}

export function MailSuggestionButtons({
  company,
  message,
  compose,
  navigate,
  onExecuted,
}: {
  company: Company;
  message: AskAiMessage;
  /** Opens the Email composer; returns false when Email must be opened first. */
  compose: (init: Partial<ComposeInput>) => boolean;
  navigate: (to: string) => void;
  onExecuted: (updated: AskAiMessage) => void;
}) {
  const dialog = useDialog();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const markExecuted = async (s: MailSuggestion) => {
    try {
      const res = await askAiApi.markSuggestionExecuted(
        company.id,
        message.conversationId,
        message.id,
        s.id,
      );
      onExecuted(res.message);
    } catch {
      // The action itself succeeded; the stamp is bookkeeping.
    }
  };

  const run = async (s: MailSuggestion) => {
    if (busyId || s.executedAt) return;
    setBusyId(s.id);
    try {
      switch (s.kind) {
        case "reply": {
          // A reply may carry only threadId + body; resolve recipients the way
          // the reply composer does so it opens ready to send.
          let to = s.to;
          let cc = s.cc;
          if (s.threadId && !to) {
            const rec = await mailApi.replyRecipients(company.id, s.threadId).catch(() => null);
            to = rec?.to;
            cc = cc ?? (rec?.cc || undefined);
          }
          const opened = compose({
            to,
            cc,
            subject: s.subject,
            bodyText: s.bodyText ?? "",
            threadId: s.threadId,
          });
          if (!opened) {
            navigate(`/c/${company.slug}/mail${s.threadId ? `/t/${s.threadId}` : ""}`);
          }
          break;
        }
        case "open_thread":
          navigate(`/c/${company.slug}/mail/t/${s.threadId}`);
          break;
        case "send_draft": {
          const ok = await dialog.confirm({
            title: "Send this draft?",
            message: (
              <span className="block whitespace-pre-wrap">
                {`To: ${s.targetTo || "(no recipients)"}\nSubject: ${s.targetSubject || "(no subject)"}`}
              </span>
            ),
            confirmLabel: "Send",
          });
          if (!ok) break;
          await mailApi.sendDraft(company.id, s.messageId!);
          await markExecuted(s);
          break;
        }
        case "thread_action": {
          if (s.action === "trash") {
            const ok = await dialog.confirm({
              title: "Move thread to trash?",
              message: s.targetSubject || "(no subject)",
              confirmLabel: "Trash",
              variant: "danger",
            });
            if (!ok) break;
          }
          await mailApi.threadAction(company.id, s.threadId!, s.action!, {
            labelName: s.labelName,
          });
          await markExecuted(s);
          break;
        }
        case "hand_over":
          await mailApi.createHandover(company.id, s.threadId!, {
            employeeId: s.employeeId!,
            instruction: s.instruction ?? "",
            mode: s.mode ?? "draft",
          });
          await markExecuted(s);
          break;
        case "create_rule":
          if (!s.accountId) throw new Error("This suggestion does not name a mailbox.");
          await mailApi.createRule(company.id, s.accountId, {
            name: s.rule!.name,
            enabled: true,
            conditions: s.rule!.conditions,
            actions: s.rule!.actions,
          });
          await markExecuted(s);
          break;
      }
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t run that suggestion" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {message.suggestions.map((s) => {
        const spent = Boolean(s.executedAt);
        const verified = verifiedTarget(s);
        return (
          <button
            key={s.id}
            type="button"
            disabled={spent || busyId !== null}
            onClick={() => void run(s)}
            title={spent ? "Already done" : suggestionHint(s)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
              spent
                ? "cursor-default border-slate-200 text-slate-400 line-through dark:border-slate-800 dark:text-slate-600"
                : "border-indigo-200 bg-indigo-50/60 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20",
            )}
          >
            {busyId === s.id ? (
              <Spinner size={12} />
            ) : spent ? (
              <Check size={12} />
            ) : (
              iconForSuggestion(s)
            )}
            <span className="min-w-0">
              <span className="block">{s.label}</span>
              {verified && !spent && (
                <span className="block max-w-[220px] truncate text-[10px] font-normal text-indigo-500/80 dark:text-indigo-300/70">
                  {verified}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
