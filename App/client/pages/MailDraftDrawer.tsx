import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink, MessageSquare, Paperclip, Send, Trash2, X } from "lucide-react";
import { Company } from "../lib/api";
import {
  ComposeInput,
  MailAccount,
  MailDraft,
  MailMessage,
  mailApi,
} from "../lib/mail";
import { MailAssistant } from "./MailAssistant";
import { DraftAuthorLine } from "../components/mail/DraftAuthor";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * Deep review for one draft, on demand.
 *
 * The queue itself stays a fast scanning surface, so everything heavy lives
 * here: the full body, attachments, the message the draft is replying to, and
 * the thread-scoped AI chat. Opening it is a deliberate act — which is why the
 * assistant is not mounted for every row the cursor passes over.
 */
export function MailDraftDrawer({
  companyId,
  companySlug,
  company,
  account,
  draft,
  onClose,
  onSend,
  onDiscard,
  openCompose,
}: {
  companyId: string;
  companySlug: string;
  company: Company;
  account: MailAccount;
  draft: MailDraft;
  onClose: () => void;
  onSend: (draft: MailDraft) => void;
  onDiscard: (draft: MailDraft) => void;
  openCompose: (init?: Partial<ComposeInput>) => void;
}) {
  const [tab, setTab] = React.useState<"draft" | "chat">("draft");
  const [messages, setMessages] = React.useState<MailMessage[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setError(null);
    mailApi
      .thread(companyId, draft.threadId)
      .then((res) => {
        if (!cancelled) setMessages(res.messages);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, draft.threadId]);

  const panelRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A confirmation opened on top of the drawer owns Escape. Without this,
      // cancelling "Discard this draft?" would also close the drawer behind it
      // — one keypress dismissing two things the person only meant to dismiss
      // one of.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      for (const el of dialogs) {
        if (el !== panelRef.current) return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const full = messages?.find((m) => m.id === draft.id) ?? null;
  // The last thing anyone actually said before the AI answered — the single
  // most useful piece of context for judging whether the reply is right.
  const context = React.useMemo(() => {
    if (!messages) return null;
    const at = messages.findIndex((m) => m.id === draft.id);
    const before = at >= 0 ? messages.slice(0, at) : messages;
    return [...before].reverse().find((m) => !m.isDraft) ?? null;
  }, [messages, draft.id]);

  return (
    <div
      className="fixed inset-0 z-[65] flex justify-end bg-slate-900/30 dark:bg-black/50"
      onMouseDown={onClose}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Review draft"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {draft.subject || "(no subject)"}
            </h2>
            <p
              className={clsx(
                "mt-0.5 truncate text-sm",
                draft.missingRecipient
                  ? "text-red-600 dark:text-red-400"
                  : "text-slate-500 dark:text-slate-400",
              )}
            >
              {draft.missingRecipient ? "No recipient yet" : `To ${draft.toEmails}`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-slate-200 px-4 dark:border-slate-800">
          <TabButton active={tab === "draft"} onClick={() => setTab("draft")}>
            Draft
          </TabButton>
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
            <MessageSquare size={13} className="mr-1.5" /> AI chat
          </TabButton>
        </div>

        {tab === "chat" ? (
          <div className="min-h-0 flex-1">
            <MailAssistant
              company={company}
              account={account}
              threadId={draft.threadId}
              focusedMessageId={draft.id}
              openCompose={openCompose}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <DraftAuthorLine
              author={draft.author}
              companyId={companyId}
              companySlug={companySlug}
              createdAt={draft.createdAt}
            />

            {messages === null && !error ? (
              <div className="flex justify-center py-10">
                <Spinner size={20} />
              </div>
            ) : error ? (
              <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
            ) : (
              <>
                <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-[15px] leading-7 text-slate-800 dark:text-slate-200">
                  {full?.bodyText || draft.bodyPreview || "(empty draft)"}
                </pre>

                {full && full.attachments.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800/70">
                    {full.attachments.map((attachment) => (
                      <a
                        key={attachment.index}
                        href={mailApi.attachmentUrl(companyId, full.id, attachment.index)}
                        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
                      >
                        <Paperclip size={12} />
                        <span className="max-w-52 truncate">{attachment.filename}</span>
                      </a>
                    ))}
                  </div>
                )}

                {context && (
                  <section className="mt-5 rounded-lg border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/50">
                    <h3 className="border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 dark:border-slate-800 dark:text-slate-300">
                      Replying to{" "}
                      <span className="font-normal text-slate-400">
                        {context.fromName || context.fromEmail}
                      </span>
                    </h3>
                    <p className="max-h-56 overflow-y-auto whitespace-pre-wrap px-3 py-3 text-xs leading-5 text-slate-600 dark:text-slate-400">
                      {context.bodyText || context.snippet}
                    </p>
                  </section>
                )}
              </>
            )}
          </div>
        )}

        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <Link
            to={`/c/${companySlug}/mail/t/${draft.threadId}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <ExternalLink size={13} /> Edit
          </Link>
          <Button size="sm" variant="ghost" onClick={() => onDiscard(draft)}>
            <Trash2 size={14} /> Discard
          </Button>
          <div className="ml-auto">
            <Button size="sm" disabled={draft.missingRecipient} onClick={() => onSend(draft)}>
              <Send size={14} /> Send
            </Button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "-mb-px flex items-center border-b-2 px-3 py-2 text-sm font-medium transition",
        active
          ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
          : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
      )}
    >
      {children}
    </button>
  );
}
