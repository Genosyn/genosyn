import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  Paperclip,
  Send,
  Users,
} from "lucide-react";
import { Company } from "../lib/api";
import {
  ComposeInput,
  MailAccount,
  MailMessage,
  MailThread,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailAssistant } from "./MailAssistant";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

type DraftThreadDetail = {
  thread: MailThread;
  messages: MailMessage[];
};

type MailDraftReviewProps = {
  companyId: string;
  companySlug: string;
  company: Company;
  account: MailAccount;
  threads: MailThread[];
  changeTick: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  onRefresh: () => Promise<void>;
  openCompose: (init?: Partial<ComposeInput>) => void;
};

/**
 * The Drafts folder is a review queue rather than another generic mail list.
 * One thread is loaded at a time, keeping a large mailbox cheap while letting
 * a teammate inspect recipients, context, attachments, and copy before sending.
 */
export function MailDraftReview({
  companyId,
  companySlug,
  company,
  account,
  threads,
  changeTick,
  hasMore,
  loadingMore,
  onLoadMore,
  onRefresh,
  openCompose,
}: MailDraftReviewProps) {
  const { toast, background } = useToast();
  const [selectedId, setSelectedId] = React.useState(threads[0]?.id ?? "");
  const [detail, setDetail] = React.useState<DraftThreadDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [hiddenThreadIds, setHiddenThreadIds] = React.useState<Set<string>>(() => new Set());
  const requestSeq = React.useRef(0);
  const selectedIdRef = React.useRef(selectedId);
  selectedIdRef.current = selectedId;

  const visibleThreads = React.useMemo(
    () => threads.filter((thread) => !hiddenThreadIds.has(thread.id)),
    [hiddenThreadIds, threads],
  );

  React.useEffect(() => {
    if (visibleThreads.some((thread) => thread.id === selectedId)) return;
    setSelectedId(visibleThreads[0]?.id ?? "");
  }, [visibleThreads, selectedId]);

  const loadDetail = React.useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      setLoading(false);
      return null;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await mailApi.thread(companyId, selectedId);
      if (seq !== requestSeq.current) return null;
      const next = { thread: res.thread, messages: res.messages };
      setDetail(next);
      return next;
    } catch (err) {
      if (seq !== requestSeq.current) return null;
      setLoadError((err as Error).message);
      setDetail(null);
      return null;
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [companyId, selectedId]);

  React.useEffect(() => {
    void loadDetail();
  }, [loadDetail, changeTick]);

  const selectedIndex = Math.max(
    0,
    visibleThreads.findIndex((thread) => thread.id === selectedId),
  );
  const drafts = detail?.messages.filter((message) => message.isDraft) ?? [];

  const sendDraft = (draft: MailMessage) => {
    if (!detail) return;
    const snapshot = detail;
    const threadId = detail.thread.id;
    const remainingDrafts = drafts.filter((message) => message.id !== draft.id);

    // Sending through Gmail can take seconds. Treat the click as the user's
    // decision immediately: remove the draft locally and let them review the
    // next item while the request finishes in the background.
    setDetail((current) =>
      current?.thread.id === threadId
        ? { ...current, messages: current.messages.filter((message) => message.id !== draft.id) }
        : current,
    );
    if (remainingDrafts.length === 0) {
      setHiddenThreadIds((current) => new Set(current).add(threadId));
      const nextThread = visibleThreads[selectedIndex + 1] ?? visibleThreads[selectedIndex - 1];
      setSelectedId(nextThread?.id ?? "");
    }

    background(() => mailApi.sendDraft(companyId, draft.id), {
      loading: "Sending draft…",
      success: "Draft sent",
      error: (error) =>
        `Couldn\u2019t send the draft: ${
          error instanceof Error ? error.message : "Unknown error"
        }. It has been returned to the queue.`,
      onSuccess: () => {
        void onRefresh().catch((error) => {
          toast(
            `Draft sent, but the queue could not refresh: ${(error as Error).message}`,
            "error",
          );
        });
      },
      onError: () => {
        setHiddenThreadIds((current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
        if (selectedIdRef.current === threadId) setDetail(snapshot);
      },
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
          <FileText size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Review queue
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Check the details, send, and move straight to the next draft.
          </div>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
          {visibleThreads.length}
          {hasMore ? "+" : ""} to review
        </span>
      </div>

      <div className="grid min-h-[32rem] grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_22rem]">
        <div className="border-b border-slate-200 dark:border-slate-800 lg:border-b-0 lg:border-r">
          <div className="max-h-72 overflow-y-auto lg:max-h-[40rem]">
            {visibleThreads.map((thread, index) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => setSelectedId(thread.id)}
                className={clsx(
                  "group flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 dark:border-slate-800/70",
                  thread.id === selectedId
                    ? "bg-indigo-50/80 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-900",
                )}
                aria-current={thread.id === selectedId ? "true" : undefined}
              >
                <span
                  className={clsx(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                    thread.id === selectedId
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-500 group-hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:group-hover:bg-slate-700",
                  )}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {thread.subject || "(no subject)"}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                      {shortMailDate(thread.lastMessageAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                    {thread.participants || "No recipient yet"}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-400 dark:text-slate-500">
                    {thread.snippet || "Empty draft"}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {hasMore && (
            <div className="border-t border-slate-100 p-2 text-center dark:border-slate-800">
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingMore}
                onClick={() => void onLoadMore()}
              >
                {loadingMore ? <Spinner size={14} /> : "Load more drafts"}
              </Button>
            </div>
          )}
        </div>

        <div className="min-w-0 bg-white dark:bg-slate-950">
          {loading ? (
            <div className="flex h-full min-h-80 items-center justify-center">
              <Spinner size={22} />
            </div>
          ) : loadError ? (
            <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Couldn&apos;t load this draft
              </div>
              <div className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                {loadError}
              </div>
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                onClick={() => void loadDetail()}
              >
                Try again
              </Button>
            </div>
          ) : detail && drafts.length > 0 ? (
            <div>
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800/70">
                <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">
                  {selectedIndex + 1} of {visibleThreads.length}
                  {hasMore ? "+" : ""}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Previous draft"
                    disabled={selectedIndex === 0}
                    onClick={() => setSelectedId(visibleThreads[selectedIndex - 1].id)}
                  >
                    <ArrowLeft size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Next draft"
                    disabled={selectedIndex >= visibleThreads.length - 1}
                    onClick={() => setSelectedId(visibleThreads[selectedIndex + 1].id)}
                  >
                    <ArrowRight size={14} />
                  </Button>
                  <Link
                    to={`/c/${companySlug}/mail/t/${detail.thread.id}`}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    <ExternalLink size={13} /> Edit draft
                  </Link>
                </div>
              </div>

              <div className="space-y-5 px-5 py-5 sm:px-7 sm:py-6">
                {drafts.map((draft) => (
                  <DraftPreview
                    key={draft.id}
                    companyId={companyId}
                    draft={draft}
                    context={lastConversationMessage(detail.messages, draft.id)}
                    onSend={() => sendDraft(draft)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center">
              <CheckCircle2 size={28} className="text-emerald-500" />
              <div className="mt-3 text-sm font-medium text-slate-800 dark:text-slate-200">
                This draft has already been handled
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Pick another item from the review queue.
              </div>
            </div>
          )}
        </div>
        <aside className="min-h-[30rem] border-t border-slate-200 bg-white lg:col-span-2 xl:col-span-1 xl:min-h-0 xl:border-l xl:border-t-0 dark:border-slate-800 dark:bg-slate-950">
          {detail && drafts.length > 0 ? (
            <MailAssistant
              company={company}
              account={account}
              threadId={detail.thread.id}
              focusedMessageId={drafts[0].id}
              openCompose={openCompose}
            />
          ) : (
            <div className="flex h-full min-h-80 items-center justify-center px-6 text-center text-sm text-slate-400">
              Pick a draft to start its AI chat.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function DraftPreview({
  companyId,
  draft,
  context,
  onSend,
}: {
  companyId: string;
  draft: MailMessage;
  context: MailMessage | null;
  onSend: () => void;
}) {
  const hasRecipient = draft.toEmails.trim().length > 0;

  return (
    <article>
      <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            Ready for review
          </span>
          {draft.attachments.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              <Paperclip size={12} /> {draft.attachments.length}
            </span>
          )}
        </div>
        <h2 className="text-xl font-semibold leading-snug text-slate-950 dark:text-white">
          {draft.subject || "(no subject)"}
        </h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[3rem_minmax(0,1fr)]">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">To</dt>
          <dd
            className={
              hasRecipient ? "text-slate-700 dark:text-slate-300" : "text-red-600 dark:text-red-400"
            }
          >
            {draft.toEmails || "Add a recipient before sending"}
          </dd>
          {draft.ccEmails && (
            <>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Cc</dt>
              <dd className="text-slate-700 dark:text-slate-300">{draft.ccEmails}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="py-5">
        <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-7 text-slate-800 dark:text-slate-200">
          {draft.bodyText || draft.snippet || "(empty draft)"}
        </pre>
      </div>

      {draft.attachments.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800/70">
          {draft.attachments.map((attachment) => (
            <a
              key={attachment.index}
              href={mailApi.attachmentUrl(companyId, draft.id, attachment.index)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
            >
              <Paperclip size={12} />
              <span className="max-w-52 truncate">{attachment.filename}</span>
            </a>
          ))}
        </div>
      )}

      {context && (
        <details className="mb-5 rounded-lg border border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/50">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Users size={13} className="text-slate-400" />
            Conversation context
            <span className="ml-auto truncate font-normal text-slate-400">
              {context.fromName || context.fromEmail}
            </span>
          </summary>
          <div className="border-t border-slate-200 px-3 py-3 text-xs leading-5 text-slate-600 dark:border-slate-800 dark:text-slate-400">
            {context.bodyText || context.snippet}
          </div>
        </details>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {hasRecipient
            ? "Sending uses the connected Gmail mailbox."
            : "Edit this draft to add a recipient."}
        </div>
        <Button disabled={!hasRecipient} onClick={onSend}>
          <Send size={14} className="mr-1.5" /> Send &amp; next
        </Button>
      </div>
    </article>
  );
}

function lastConversationMessage(messages: MailMessage[], draftId: string): MailMessage | null {
  const draftIndex = messages.findIndex((message) => message.id === draftId);
  const beforeDraft = draftIndex >= 0 ? messages.slice(0, draftIndex) : messages;
  return [...beforeDraft].reverse().find((message) => !message.isDraft) ?? null;
}
