import React from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import createDOMPurify from "dompurify";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  CalendarPlus,
  ChevronDown,
  Forward,
  Image as ImageIcon,
  Mail,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  MailAccessLevel,
  MailAnalysis,
  MailGrant,
  MailHandover,
  MailHandoverMode,
  MailMessage,
  MailReviewTimelineData,
  MailThread,
  ThreadActionName,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailAnalysisCard } from "./MailAnalysisCard";
import { MailOutletCtx } from "./MailLayout";
import { ReplyComposer, type ReplyComposerHandle } from "./MailReplyComposer";
import { ScheduleMeetingModal, type ScheduleMeetingPrefill } from "./MailScheduleMeeting";
import { useAskAiPageContext } from "../components/askAi/AskAiProvider";
import { Button } from "../components/ui/Button";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuHeader, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { Avatar } from "../components/ui/Avatar";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { AttachmentBar, useMailAttachments } from "../components/MailAttachments";
import {
  MailRecipientFields,
  type MailRecipientFieldsHandle,
  useMailRecipientCheck,
} from "../components/mail/MailRecipientFields";
import { allAttachmentIndexes, draftEditorIsDirty, withoutAttachment } from "../lib/draftEditor";
import { errorMessage } from "../lib/errors";
import { shouldIgnoreShortcut } from "../lib/keyboard";
import { quotedTailStart, replyRecipientsFor } from "../lib/mailCompose";
import {
  mailHeaders,
  mailRecipientProblem,
  mailRecipientsFrom,
  type MailRecipients,
  sameMailRecipients,
  threadParticipants,
} from "../lib/mailRecipients";
import { parseRecipients, recipientKey } from "../lib/recipientTokens";
import { clsx } from "../components/ui/clsx";
import { MailReviewTimeline } from "@/pages/MailReviewTimeline";
import { currentMailAnalysis, mergeMailThreadUpdate } from "@/lib/mailReview";

/**
 * One conversation: messages (sanitized HTML, remote images blocked until
 * asked), Member-authored mailbox drafts (edit → send), a reply composer,
 * thread actions, and the "Hand to AI" flow with the handover timeline. AI
 * reply previews go to the Decision stack rather than provider Drafts.
 */

// Dedicated DOMPurify instance so our hooks don't change how the rest of the
// app (chat markdown etc.) sanitizes. Remote-image blocking is done inside a
// sanitize hook that inspects the parsed DOM — a regex over serialized HTML is
// unsafe (a `>` inside any attribute value defeats it, letting a tracking
// pixel through). Inline `data:`/`cid:` images are never blocked; only real
// remote fetches (http/https/protocol-relative) are gated behind a click.
let sanitizeAllowImages = true;
let sanitizeSawRemoteImage = false;

const purifier = createDOMPurify(window);
purifier.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (el.tagName === "A") {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
  if (el.tagName === "IMG") {
    const src = el.getAttribute("src") ?? "";
    const isRemote = /^(https?:)?\/\//i.test(src.trim());
    if (isRemote) {
      sanitizeSawRemoteImage = true;
      if (!sanitizeAllowImages) {
        el.removeAttribute("src");
        el.setAttribute("data-blocked-src", src);
      }
    }
  }
});

/**
 * Sanitize an email body. Returns the cleaned HTML and whether it contained
 * any remote images (so the caller can show the "Show images" banner).
 */
function sanitizeEmailHtml(
  html: string,
  allowImages: boolean,
): { html: string; hadRemoteImages: boolean } {
  sanitizeAllowImages = allowImages;
  sanitizeSawRemoteImage = false;
  const clean = purifier.sanitize(html, {
    FORBID_TAGS: ["style", "title", "meta", "link", "form", "input", "button", "base"],
    FORBID_ATTR: ["srcset"],
  });
  return { html: clean, hadRemoteImages: sanitizeSawRemoteImage };
}

const MODE_LABELS: Record<MailHandoverMode, string> = {
  work: "Do the work and prepare a reply",
  draft: "Prepare a reply for review",
  reply: "Reply directly (sends mail)",
  triage: "Triage only (labels / archive)",
};

const DEFAULT_INSTRUCTIONS: Record<MailHandoverMode, string> = {
  work: "Complete the underlying work with your granted company resources, then prepare a reply with the resulting artifacts for review.",
  draft: "Prepare a reply to this email in our usual tone for me to review in Genosyn.",
  reply: "Reply to this email.",
  triage: "Categorize this email with an appropriate label and archive it if no action is needed.",
};

function applyThreadAction(
  thread: MailThread,
  action: ThreadActionName,
  labelId?: string,
): MailThread {
  const labels = new Set(thread.labelIds);
  if (action === "star") labels.add("STARRED");
  if (action === "unstar") labels.delete("STARRED");
  if (action === "archive") labels.delete("INBOX");
  if (action === "moveToInbox") {
    labels.add("INBOX");
    labels.delete("TRASH");
  }
  if (action === "trash") {
    labels.add("TRASH");
    labels.delete("INBOX");
  }
  if (action === "untrash") labels.delete("TRASH");
  if (action === "applyLabel" && labelId) labels.add(labelId);
  if (action === "removeLabel" && labelId) labels.delete(labelId);
  return {
    ...thread,
    labelIds: [...labels],
    unread: action === "markRead" ? false : action === "markUnread" ? true : thread.unread,
  };
}

export default function MailThreadView() {
  const { company, account, labels, changeTick } = useOutletContext<MailOutletCtx>();
  const { threadId } = useParams();
  const background = useBackgroundAction();
  const navigate = useNavigate();
  const location = useLocation();
  const scrolledToHandover = React.useRef<string | null>(null);
  const loadSeq = React.useRef(0);
  /**
   * The thread the Member just marked unread. Opening a thread marks it read;
   * without this, a reload seeing it unread again would undo their choice.
   */
  const keptUnread = React.useRef<string | null>(null);
  /** This thread's keyboard actions, current as of the last render; null while loading. */
  const shortcuts = React.useRef<((key: string) => boolean) | null>(null);
  const replyRef = React.useRef<ReplyComposerHandle>(null);
  const requestScope = `${company.id}:${threadId ?? ""}`;
  const activeRequestScope = React.useRef(requestScope);
  React.useLayoutEffect(() => {
    activeRequestScope.current = requestScope;
    return () => {
      activeRequestScope.current = "";
      loadSeq.current += 1;
    };
  }, [requestScope]);

  const [thread, setThread] = React.useState<MailThread | null>(null);
  const [messages, setMessages] = React.useState<MailMessage[]>([]);
  const [handovers, setHandovers] = React.useState<MailHandover[]>([]);
  const [analyses, setAnalyses] = React.useState<MailAnalysis[]>([]);
  const [reviewTimeline, setReviewTimeline] = React.useState<MailReviewTimelineData | null>(null);
  const [handoverDetailsOpen, setHandoverDetailsOpen] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [handOpen, setHandOpen] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [scheduling, setScheduling] = React.useState<{
    prefill: ScheduleMeetingPrefill | null;
  } | null>(null);
  const sentMessages = React.useMemo(() => messages.filter((m) => !m.isDraft), [messages]);
  const participants = React.useMemo(
    () => threadParticipants(sentMessages, [account.address]),
    [sentMessages, account.address],
  );
  const newestMessage = sentMessages[sentMessages.length - 1] ?? null;
  const meetingGuests = React.useMemo(() => {
    if (!newestMessage) return [];
    const fields = replyRecipientsFor(newestMessage, account.address, true);
    return [...fields.to, ...fields.cc];
  }, [newestMessage, account.address]);

  const load = React.useCallback(async () => {
    if (!threadId || activeRequestScope.current !== requestScope) return;
    const seq = ++loadSeq.current;
    try {
      const res = await mailApi.thread(company.id, threadId);
      if (seq !== loadSeq.current || activeRequestScope.current !== requestScope) return;
      setThread(res.thread);
      setMessages(res.messages);
      setHandovers(res.handovers);
      setLoadError(null);
      setAnalyses(res.analyses ?? []);
      setReviewTimeline(res.reviewTimeline ?? null);
      setNotFound(false);
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set<string>();
        const nonDrafts = res.messages.filter((m) => !m.isDraft);
        const last = nonDrafts[nonDrafts.length - 1];
        if (last) next.add(last.id);
        for (const m of res.messages) {
          if (m.isDraft || m.labelIds.includes("UNREAD")) next.add(m.id);
        }
        return next;
      });
    } catch (err) {
      if (seq !== loadSeq.current || activeRequestScope.current !== requestScope) return;
      const message = errorMessage(err, "Could not load the thread");
      if (message.includes("not found")) setNotFound(true);
      else setLoadError(message);
    }
  }, [company.id, threadId, requestScope]);

  const retry = async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  };

  React.useEffect(() => {
    setThread(null);
    setNotFound(false);
    setLoadError(null);
    setMessages([]);
    setHandovers([]);
    setAnalyses([]);
    setReviewTimeline(null);
    setHandoverDetailsOpen(false);
    setHandOpen(false);
    setScheduling(null);
    scrolledToHandover.current = null;
    keptUnread.current = null;
    setExpanded(new Set());
    void load();
    return () => {
      loadSeq.current += 1;
    };
  }, [load]);

  React.useEffect(() => {
    if (changeTick === 0) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick]);

  // Socket updates normally drive this surface. A visible, active review also
  // checks periodically so reconnecting cannot leave a permanent working badge.
  const workInProgress =
    thread?.aiReview?.status === "reviewing" ||
    thread?.aiReview?.status === "queued" ||
    handovers.some((handover) => handover.status === "pending" || handover.status === "running");
  React.useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    const timer = workInProgress ? window.setInterval(onFocus, 5_000) : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [load, workInProgress]);

  React.useEffect(() => {
    const match = /^#handover-([0-9a-f-]+)$/i.exec(window.location.hash);
    if (!match || !handovers.some((handover) => handover.id === match[1])) return;
    if (scrolledToHandover.current === match[1]) return;
    setHandoverDetailsOpen(true);
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`handover-${match[1]}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus();
      scrolledToHandover.current = match[1];
    });
    return () => window.cancelAnimationFrame(frame);
  }, [handovers]);

  // Opening a thread marks it read, like every mail client — unless the
  // Member just marked it unread, which this must never quietly reverse.
  React.useEffect(() => {
    if (!thread || !thread.unread || keptUnread.current === thread.id) return;
    mailApi.threadAction(company.id, thread.id, "markRead").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.unread]);

  // The keys the mail guide lists work in an open thread too: e archive,
  // # trash, s star, u mark unread, r reply, a reply all, f forward.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      // A menu (Labels) owns its own letters while it is open.
      if (document.querySelector('[role="menu"]')) return;
      if (shortcuts.current?.(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The thread is already in the URL. Its newest unsent draft is what Ask AI
  // should mean by "this draft".
  const newestDraftId = [...messages].reverse().find((message) => message.isDraft)?.id;
  useAskAiPageContext(
    thread && newestDraftId
      ? [{ kind: "mail_thread", id: thread.id, focusId: newestDraftId }]
      : null,
  );

  const base = `/c/${company.slug}/mail`;
  // Back to wherever this thread was opened from — the folder, label or search
  // it sat in — or the inbox when it was opened straight from a link.
  const leave = () => {
    if (location.key === "default") navigate(base, { replace: true });
    else navigate(-1);
  };

  shortcuts.current = null;
  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-slate-500">
        This thread no longer exists.{" "}
        <Link to={base} className="text-indigo-600 hover:underline dark:text-indigo-400">
          Back to inbox
        </Link>
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        {loadError ? (
          <div className="space-y-3">
            <FormError message={loadError} />
            <Button variant="secondary" size="sm" loading={retrying} onClick={() => void retry()}>
              Try again
            </Button>
          </div>
        ) : (
          <Spinner size={22} />
        )}
      </div>
    );
  }

  const starred = thread.labelIds.includes("STARRED");
  const inInbox = thread.labelIds.includes("INBOX");
  const inTrash = thread.labelIds.includes("TRASH");
  const userLabels = labels.filter((l) => l.labelType === "user");
  const threadUserLabels = userLabels.filter((l) => thread.labelIds.includes(l.gmailLabelId));

  const act = (action: ThreadActionName, opts?: { labelId?: string; labelName?: string }) => {
    const snapshot = thread;
    setThread(applyThreadAction(thread, action, opts?.labelId));
    // Archiving, trashing or marking unread is done with the thread: go back
    // to the list it came from instead of leaving a Back click to do.
    if (action === "markUnread") keptUnread.current = thread.id;
    if (action === "archive" || action === "trash" || action === "markUnread") leave();

    background(() => mailApi.threadAction(company.id, thread.id, action, opts), {
      title: "Couldn’t update the email",
      error: (error) => `${errorMessage(error)} The change was undone.`,
      onSuccess: ({ thread: updated }) => {
        if (updated)
          setThread((current) => (current ? mergeMailThreadUpdate(current, updated) : current));
      },
      onError: () =>
        setThread((current) =>
          current?.id === snapshot.id
            ? { ...current, unread: snapshot.unread, labelIds: snapshot.labelIds }
            : current,
        ),
    });
  };

  const latestAnalysis = currentMailAnalysis(analyses, thread.aiReview);
  const canReply = !inTrash && messages.some((m) => !m.isDraft);
  // "Edit" in the Drafts queue opens that draft's editor on arrival.
  const editDraftId = (location.state as { editDraftId?: unknown } | null)?.editDraftId;
  shortcuts.current = (key) => {
    switch (key) {
      case "e":
        if (!inInbox || inTrash) return false;
        act("archive");
        return true;
      case "#":
        if (inTrash) return false;
        act("trash");
        return true;
      case "s":
        act(starred ? "unstar" : "star");
        return true;
      case "u":
        act("markUnread");
        return true;
      case "r":
      case "a":
      case "f":
        if (!canReply) return false;
        replyRef.current?.open(key === "a" ? "replyAll" : key === "f" ? "forward" : "reply");
        return true;
      default:
        return false;
    }
  };

  return (
    <div className="flex min-h-full flex-col xl:h-full xl:min-h-0 xl:flex-row xl:overflow-hidden">
      <main className="min-w-0 flex-1 xl:overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
          {/* Header */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={leave}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-tight text-slate-900 sm:text-xl dark:text-slate-100">
              {thread.subject || "(no subject)"}
            </h1>
            <div className="ml-auto flex w-full shrink-0 flex-wrap items-center justify-end gap-0.5 sm:w-auto">
              <HeaderAction
                title={starred ? "Unstar" : "Star"}
                onClick={() => act(starred ? "unstar" : "star")}
              >
                <Star
                  size={15}
                  fill={starred ? "currentColor" : "none"}
                  className={starred ? "text-amber-400" : undefined}
                />
              </HeaderAction>
              <HeaderAction title="Mark unread" onClick={() => act("markUnread")}>
                <Mail size={15} />
              </HeaderAction>
              {!inTrash && (
                <HeaderAction
                  title={inInbox ? "Archive" : "Move to inbox"}
                  onClick={() => act(inInbox ? "archive" : "moveToInbox")}
                >
                  {inInbox ? <Archive size={15} /> : <ArchiveRestore size={15} />}
                </HeaderAction>
              )}
              <HeaderAction
                title={inTrash ? "Restore from trash" : "Move to trash"}
                onClick={() => act(inTrash ? "untrash" : "trash")}
              >
                {inTrash ? <ArchiveRestore size={15} /> : <Trash2 size={15} />}
              </HeaderAction>
              <Menu
                align="right"
                trigger={({ ref, onClick }) => (
                  <button
                    ref={ref}
                    onClick={onClick}
                    title="Labels"
                    className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                  >
                    <Tag size={15} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuHeader>Labels</MenuHeader>
                    {userLabels.length === 0 && (
                      <div className="px-2 py-1.5 text-xs text-slate-400">
                        No user labels yet — AI rules can create them.
                      </div>
                    )}
                    {userLabels.map((l) => {
                      const has = thread.labelIds.includes(l.gmailLabelId);
                      return (
                        <MenuItem
                          key={l.id}
                          label={l.name}
                          active={has}
                          onSelect={() => {
                            close();
                            void act(has ? "removeLabel" : "applyLabel", {
                              labelId: l.gmailLabelId,
                            });
                          }}
                        />
                      );
                    })}
                  </>
                )}
              </Menu>
              {canReply && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setScheduling({ prefill: null })}
                  title="Schedule a meeting with the people on this thread"
                  aria-label="Schedule a meeting"
                >
                  <CalendarPlus size={14} className="sm:mr-1.5" />
                  <span className="hidden sm:inline">Schedule</span>
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setHandOpen(true)}>
                <Bot size={14} className="mr-1.5" /> Hand to AI
              </Button>
            </div>
          </div>

          {/* Who is on the conversation, how long it is, and its labels */}
          <div className="mb-4 ml-9 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">
              {sentMessages.length} {sentMessages.length === 1 ? "message" : "messages"}
            </span>
            {participants.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span
                  className="min-w-0 max-w-full truncate"
                  title={participants.map((p) => p.email).join(", ")}
                >
                  {participantNames(participants)}
                </span>
              </>
            )}
            {threadUserLabels.map((l) => (
              <Badge
                key={l.id}
                capitalize={false}
                icon={<Tag style={l.color ? { color: l.color } : undefined} />}
              >
                {l.name}
              </Badge>
            ))}
          </div>

          {/* A refresh that failed after the thread was already on screen */}
          {loadError && (
            <div className="mb-3 space-y-2">
              <FormError message={loadError} />
              <Button variant="secondary" size="sm" loading={retrying} onClick={() => void retry()}>
                Try again
              </Button>
            </div>
          )}

          <MailReviewTimeline
            key={thread.id}
            review={thread.aiReview}
            timeline={reviewTimeline}
            companySlug={company.slug}
            error={reviewTimeline ? null : "The timeline is unavailable. Refresh to try again."}
            onRetry={() => void load()}
          />

          {/* What the AI made of the newest inbound message. Only the latest
              is shown: triage is about the email that just landed, and a
              stack of verdicts for a long thread is scroll, not signal. */}
          {latestAnalysis && (
            <MailAnalysisCard
              key={latestAnalysis.id}
              analysis={latestAnalysis}
              companyId={company.id}
              companySlug={company.slug}
              financeAccess={company.financeAccess}
              onChanged={load}
              onArchived={leave}
              onScheduleMeeting={(prefill) => setScheduling({ prefill })}
            />
          )}

          {/* The timeline owns the chronology; this disclosure keeps detailed
              reports and retry controls available without duplicating it. */}
          {handovers.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                aria-expanded={handoverDetailsOpen}
                aria-controls="mail-handover-details"
                onClick={() => setHandoverDetailsOpen((open) => !open)}
                className="inline-flex items-center gap-1.5 rounded py-1 text-xs font-medium text-slate-500 outline-none hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-focus dark:text-slate-400 dark:hover:text-indigo-300"
              >
                <ChevronDown
                  size={13}
                  aria-hidden="true"
                  className={handoverDetailsOpen ? "rotate-180" : undefined}
                />
                Handover details
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs tabular-nums dark:bg-slate-800">
                  {handovers.length}
                </span>
                {handovers.some((handover) => handover.status === "failed") && (
                  <span className="text-amber-700 dark:text-amber-400">Needs attention</span>
                )}
              </button>
              <div
                id="mail-handover-details"
                hidden={!handoverDetailsOpen}
                className="mt-2 space-y-2"
              >
                {handovers.map((h) => (
                  <HandoverCard
                    key={h.id}
                    handover={h}
                    companyId={company.id}
                    companySlug={company.slug}
                    onChanged={load}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Messages: the conversation as one card, drafts on their own */}
          <div className="space-y-3">
            {conversationRuns(messages).map((run) =>
              run.kind === "draft" ? (
                <DraftCard
                  key={run.message.id}
                  draft={run.message}
                  companyId={company.id}
                  companySlug={company.slug}
                  accountId={account.id}
                  selfAddress={account.address}
                  participants={participants}
                  startEditing={run.message.id === editDraftId}
                  onChanged={load}
                />
              ) : (
                <ConversationCard
                  key={run.messages[0].id}
                  messages={run.messages}
                  expanded={expanded}
                  renderMessage={(m) => (
                    <MessageCard
                      key={m.id}
                      message={m}
                      companyId={company.id}
                      selfAddress={account.address}
                      expanded={expanded.has(m.id)}
                      onReply={(mode) => replyRef.current?.open(mode, m)}
                      canReply={canReply}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        })
                      }
                    />
                  )}
                />
              ),
            )}
          </div>

          {/* Reply composer */}
          {canReply && (
            <ReplyComposer
              ref={replyRef}
              companyId={company.id}
              companySlug={company.slug}
              accountId={account.id}
              selfAddress={account.address}
              thread={thread}
              messages={messages}
              onSent={load}
              onDraftSaved={load}
              onScheduleMeeting={() => setScheduling({ prefill: null })}
            />
          )}

          <ScheduleMeetingModal
            open={scheduling !== null}
            onClose={() => setScheduling(null)}
            companyId={company.id}
            companySlug={company.slug}
            accountId={account.id}
            selfAddress={account.address}
            threadId={thread.id}
            subject={thread.subject}
            participants={participants}
            defaultAttendees={meetingGuests}
            prefill={scheduling?.prefill ?? null}
            onAddToReply={(text) => replyRef.current?.insertText(text)}
          />

          <HandToAiModal
            open={handOpen}
            onClose={() => setHandOpen(false)}
            companyId={company.id}
            companySlug={company.slug}
            accountId={account.id}
            threadId={thread.id}
            onCreated={load}
          />
        </div>
      </main>
    </div>
  );
}

function HeaderAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={() => void onClick()}
      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      {children}
    </button>
  );
}

// ───────────────────────────── conversation ─────────────────────────────

type ConversationRun =
  | { kind: "messages"; messages: MailMessage[] }
  | { kind: "draft"; message: MailMessage };

/** Consecutive sent and received messages share one card; a draft stands on its own. */
function conversationRuns(messages: MailMessage[]): ConversationRun[] {
  const runs: ConversationRun[] = [];
  for (const message of messages) {
    if (message.isDraft) {
      runs.push({ kind: "draft", message });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === "messages") last.messages.push(message);
    else runs.push({ kind: "messages", messages: [message] });
  }
  return runs;
}

/** "Felix Menzel, Dana Lee and 3 others" — who is on a conversation besides the mailbox. */
function participantNames(people: Array<{ email: string; name: string }>): string {
  const names = people.map((person) => person.name || person.email);
  if (names.length <= 3) return names.join(", ");
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(", ")} and ${rest} others`;
}

/** Messages a long conversation folds away by default: the closed middle of it. */
export function foldedMessageIds(messages: MailMessage[], expanded: Set<string>): Set<string> {
  // Short conversations show every header; the first message and the two
  // newest always stay, so the thread reads as where it began and where it is.
  if (messages.length <= 4) return new Set();
  const middle = messages.slice(1, -2).filter((message) => !expanded.has(message.id));
  return middle.length >= 2 ? new Set(middle.map((message) => message.id)) : new Set();
}

/**
 * One conversation, one card: each message a row, the closed middle of a
 * long thread folded into "3 earlier messages" the way mail clients do, so
 * the newest message is never a long scroll away — least of all on a phone.
 */
function ConversationCard({
  messages,
  expanded,
  renderMessage,
}: {
  messages: MailMessage[];
  expanded: Set<string>;
  renderMessage: (message: MailMessage) => React.ReactNode;
}) {
  const [unfolded, setUnfolded] = React.useState(false);
  const folded = unfolded ? new Set<string>() : foldedMessageIds(messages, expanded);
  const rows: React.ReactNode[] = [];
  let run: MailMessage[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const count = run.length;
    rows.push(
      <button
        key={`fold-${run[0].id}`}
        type="button"
        onClick={() => setUnfolded(true)}
        className="group flex w-full items-center gap-3 px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/40"
      >
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 tabular-nums group-hover:border-indigo-300 group-hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:group-hover:border-indigo-500/50 dark:group-hover:text-indigo-300">
          {count} earlier {count === 1 ? "message" : "messages"}
        </span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
      </button>,
    );
    run = [];
  };
  for (const message of messages) {
    if (folded.has(message.id)) {
      run.push(message);
      continue;
    }
    flush();
    rows.push(renderMessage(message));
  }
  flush();
  return (
    <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {rows}
    </div>
  );
}

// ───────────────────────────── message card ─────────────────────────────

/**
 * The quoted history at the bottom of an HTML email — Gmail's `gmail_quote`,
 * Apple Mail's `blockquote type=cite`, Outlook's reply header — folded away
 * the way mail clients do. Only a quote that ends the message is folded, and
 * only when the message has words of its own above it; a forward is never
 * folded, since it is the point of the email.
 */
function foldHtmlQuote(html: string): { main: string; folded: boolean } {
  if (!html) return { main: html, folded: false };
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  const quote = root.querySelector(
    ".gmail_quote, blockquote[type='cite'], #appendonsend, #divRplyFwdMsg, .yahoo_quoted, .moz-cite-prefix",
  );
  if (!quote || !root.lastChild) return { main: html, folded: false };
  if (/forwarded message/i.test((quote.textContent ?? "").slice(0, 200))) {
    return { main: html, folded: false };
  }
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEndBefore(quote);
  const ownWords =
    before.toString().trim() !== "" || before.cloneContents().querySelector("img") !== null;
  const after = document.createRange();
  after.setStartAfter(quote);
  after.setEndAfter(root.lastChild);
  if (!ownWords || after.toString().trim() !== "") return { main: html, folded: false };
  const tail = document.createRange();
  tail.setStartBefore(quote);
  tail.setEndAfter(root.lastChild);
  tail.deleteContents();
  return { main: template.innerHTML, folded: true };
}

/** "Felix Menzel, Dana" — the people on a header line, by the names they go by. */
function peopleOn(header: string, selfAddress: string): string {
  const self = recipientKey(selfAddress);
  return parseRecipients(header)
    .map((person) => (recipientKey(person.email) === self ? "me" : person.name || person.email))
    .join(", ");
}

function MessageCard({
  message,
  companyId,
  selfAddress,
  expanded,
  canReply,
  onReply,
  onToggle,
}: {
  message: MailMessage;
  companyId: string;
  selfAddress: string;
  expanded: boolean;
  canReply: boolean;
  onReply: (mode: "reply" | "replyAll" | "forward") => void;
  onToggle: () => void;
}) {
  const [showImages, setShowImages] = React.useState(false);
  const [showQuote, setShowQuote] = React.useState(false);
  const rendered = React.useMemo(
    () =>
      message.bodyHtml
        ? sanitizeEmailHtml(message.bodyHtml, showImages)
        : { html: "", hadRemoteImages: false },
    [message.bodyHtml, showImages],
  );
  const folded = React.useMemo(() => foldHtmlQuote(rendered.html), [rendered.html]);
  const html = showQuote ? rendered.html : folded.main;
  const hasRemoteImages = rendered.hadRemoteImages;
  const text = message.bodyText || message.snippet;
  const textQuoteAt = React.useMemo(
    () => (rendered.html ? -1 : quotedTailStart(text)),
    [rendered.html, text],
  );
  const hasQuote = rendered.html ? folded.folded : textQuoteAt > 0;
  const isSelf = message.fromEmail.toLowerCase() === selfAddress.toLowerCase();
  const fromLabel = isSelf ? "me" : message.fromName || message.fromEmail;
  const to = peopleOn(message.toEmails, selfAddress);
  const cc = peopleOn(message.ccEmails, selfAddress);
  const others = parseRecipients(`${message.toEmails}, ${message.ccEmails}`).filter(
    (person) =>
      recipientKey(person.email) !== recipientKey(selfAddress) &&
      recipientKey(person.email) !== recipientKey(message.fromEmail),
  ).length;
  const sentAtTitle = message.sentAt ? new Date(message.sentAt).toLocaleString() : undefined;

  return (
    <div data-message-id={message.id}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className={clsx(
          "flex w-full items-center gap-3 px-4 py-3 text-left",
          !expanded && "hover:bg-slate-50 dark:hover:bg-slate-800/40",
        )}
      >
        <Avatar name={isSelf ? "Me" : message.fromName || message.fromEmail} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
              {fromLabel}
            </span>
            {expanded && !isSelf && (
              <span className="hidden min-w-0 truncate text-xs text-slate-400 sm:inline">
                {message.fromEmail}
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {expanded ? (
              <span
                title={[
                  `To: ${message.toEmails}`,
                  message.ccEmails ? `Cc: ${message.ccEmails}` : "",
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                to {to || "(unknown)"}
                {cc ? ` · cc ${cc}` : ""}
              </span>
            ) : (
              message.snippet
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 self-start pt-0.5">
          {message.attachments.length > 0 && (
            <Paperclip size={12} className="text-slate-400" aria-label="Has attachments" />
          )}
          <span className="text-xs tabular-nums text-slate-400" title={sentAtTitle}>
            {shortMailDate(message.sentAt)}
          </span>
          <ChevronDown
            size={14}
            className={clsx(
              "text-slate-300 transition-transform dark:text-slate-600",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800/70">
          {hasRemoteImages && !showImages && (
            <button
              onClick={() => setShowImages(true)}
              className="mb-3 flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <ImageIcon size={12} /> Remote images are hidden — show images
            </button>
          )}
          {rendered.html ? (
            <div className="mail-html" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700 dark:text-slate-300">
              {hasQuote && !showQuote ? text.slice(0, textQuoteAt).trimEnd() : text}
            </pre>
          )}
          {hasQuote && (
            <button
              type="button"
              onClick={() => setShowQuote((open) => !open)}
              aria-expanded={showQuote}
              aria-label={showQuote ? "Hide quoted history" : "Show quoted history"}
              title={showQuote ? "Hide the quoted history" : "Show the quoted history"}
              className="mt-2 flex h-6 items-center rounded-md bg-slate-100 px-2 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              <MoreHorizontal size={14} aria-hidden />
            </button>
          )}
          {message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800/70">
              {message.attachments.map((a) => (
                <a
                  key={a.index}
                  href={mailApi.attachmentUrl(companyId, message.id, a.index)}
                  className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Paperclip size={12} />
                  <span className="max-w-48 truncate">{a.filename}</span>
                  <span className="text-slate-400">{formatBytes(a.size)}</span>
                </a>
              ))}
            </div>
          )}
          {canReply && (
            <div className="mt-3 flex flex-wrap justify-end gap-1">
              <MessageAction
                icon={<Reply size={13} />}
                label="Reply"
                onClick={() => onReply("reply")}
              />
              {others > 0 && (
                <MessageAction
                  icon={<ReplyAll size={13} />}
                  label="Reply all"
                  onClick={() => onReply("replyAll")}
                />
              )}
              <MessageAction
                icon={<Forward size={13} />}
                label="Forward"
                onClick={() => onReply("forward")}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="touch-target relative flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-indigo-600 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-indigo-400"
    >
      {icon} {label}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ───────────────────────────── draft card ─────────────────────────────

function savedRecipients(draft: MailMessage): MailRecipients {
  return mailRecipientsFrom({ to: draft.toEmails, cc: draft.ccEmails, bcc: draft.bccEmails });
}

function DraftCard({
  draft,
  companyId,
  companySlug,
  accountId,
  selfAddress,
  participants,
  startEditing = false,
  onChanged,
}: {
  draft: MailMessage;
  companyId: string;
  companySlug: string;
  accountId: string;
  selfAddress: string;
  participants: ReturnType<typeof threadParticipants>;
  /** Open with the editor showing — the Drafts queue's Edit asked for it. */
  startEditing?: boolean;
  onChanged: () => Promise<void>;
}) {
  const background = useBackgroundAction();
  const dialog = useDialog();
  const [editing, setEditing] = React.useState(startEditing);
  const [fields, setFields] = React.useState<MailRecipients>(() => savedRecipients(draft));
  const fieldsRef = React.useRef<MailRecipientFieldsHandle>(null);
  const blocked = useMailRecipientCheck(
    companyId,
    accountId,
    editing ? fields : savedRecipients(draft),
  );
  const [subject, setSubject] = React.useState(draft.subject);
  const [body, setBody] = React.useState(draft.bodyText);
  const [busy, setBusy] = React.useState<"save" | "send" | "discard" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState(false);
  // Files already on the draft that the editor is still keeping, by their
  // index in `draft.attachments`. Removing a chip drops it from this list,
  // and the save call tells the server which ones survived.
  const [kept, setKept] = React.useState<number[]>(() =>
    allAttachmentIndexes(draft.attachments.length),
  );
  const attach = useMailAttachments(companyId, accountId);
  const clearAttach = attach.clear;
  const keptAttachments = draft.attachments.filter((a) => kept.includes(a.index));
  // Attachment indexes are positional, so the count is the whole identity of
  // the list — and unlike `draft.attachments` it doesn't change on every
  // reload, which would otherwise reset an edit in progress.
  const attachmentCount = draft.attachments.length;

  React.useEffect(() => {
    setFields(mailRecipientsFrom({ to: draft.toEmails, cc: draft.ccEmails, bcc: draft.bccEmails }));
    setSubject(draft.subject);
    setBody(draft.bodyText);
    setKept(allAttachmentIndexes(attachmentCount));
    clearAttach();
  }, [
    draft.id,
    draft.toEmails,
    draft.ccEmails,
    draft.bccEmails,
    draft.subject,
    draft.bodyText,
    attachmentCount,
    clearAttach,
  ]);

  const save = async (recipients: MailRecipients = fields): Promise<string | null> => {
    // Returns the (possibly new) draft id — Gmail reissues ids on update.
    const headers = mailHeaders(recipients);
    const res = await mailApi.updateDraft(companyId, draft.id, {
      to: headers.to,
      cc: headers.cc,
      bcc: headers.bcc,
      subject,
      bodyText: body,
      attachmentIds: attach.ids.length ? attach.ids : undefined,
      keepAttachmentIndexes: kept,
    });
    // The tokens are spent — a retry would attach nothing, and the reload
    // below brings the files back as part of the draft.
    clearAttach();
    return res.message.id;
  };

  const recipientsChanged = (recipients: MailRecipients) =>
    !sameMailRecipients(recipients, savedRecipients(draft));
  const dirty =
    recipientsChanged(fields) ||
    draftEditorIsDirty(draft, {
      to: draft.toEmails,
      subject,
      bodyText: body,
      keptIndexes: kept,
      stagedIds: attach.ids,
    });

  const onSend = () => {
    setError(null);
    const recipients = editing ? (fieldsRef.current?.commit() ?? fields) : fields;
    const problem = mailRecipientProblem(recipients);
    if (problem) {
      if (!editing) setEditing(true);
      setError(problem);
      return;
    }
    if (blocked.length > 0) {
      if (!editing) setEditing(true);
      setError("Remove the recipients who can’t be emailed first.");
      return;
    }
    const mustSave = dirty || recipientsChanged(recipients);
    setHidden(true);
    background(
      async () => {
        let id = draft.id;
        if (mustSave) id = (await save(recipients)) ?? draft.id;
        return mailApi.sendDraft(companyId, id);
      },
      {
        title: "Couldn’t send the draft",
        error: (sendError) => `${errorMessage(sendError)} It has been restored.`,
        onSuccess: () => void onChanged(),
        onError: () => setHidden(false),
      },
    );
  };

  if (hidden) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <Badge tone="warning">Draft</Badge>
        {/* Wide enough to read the addresses; on a phone the buttons wrap below. */}
        <div className="min-w-0 flex-1 basis-48 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <div className="break-words">to {draft.toEmails || "(no recipient yet)"}</div>
          {draft.ccEmails && <div className="break-words">cc {draft.ccEmails}</div>}
          {draft.bccEmails && <div className="break-words">bcc {draft.bccEmails}</div>}
        </div>
        {!editing && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={onSend}>
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Discard draft?",
                  message: "The draft is removed here and from Gmail.",
                  variant: "danger",
                });
                if (!ok) return;
                setHidden(true);
                background(() => mailApi.discardDraft(companyId, draft.id), {
                  title: "Couldn’t discard the draft",
                  error: (discardError) => `${errorMessage(discardError)} It has been restored.`,
                  onSuccess: () => void onChanged(),
                  onError: () => setHidden(false),
                });
              }}
            >
              Discard
            </Button>
          </div>
        )}
      </div>
      {!editing ? (
        <div className="border-t border-amber-100 px-4 py-3 dark:border-amber-500/20">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700 dark:text-slate-300">
            {draft.bodyText || draft.snippet}
          </pre>
          {draft.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-amber-100 pt-3 dark:border-amber-500/20">
              {draft.attachments.map((a) => (
                <a
                  key={a.index}
                  href={mailApi.attachmentUrl(companyId, draft.id, a.index)}
                  className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Paperclip size={12} />
                  <span className="max-w-48 truncate">{a.filename}</span>
                  <span className="text-slate-400">{formatBytes(a.size)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className="space-y-3 border-t border-amber-100 px-4 py-3 dark:border-amber-500/20"
          onKeyDown={(event) => {
            // The thread's one-key shortcuts stay off while a draft is being
            // edited, even with focus on one of the editor's buttons.
            if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.stopPropagation();
            }
          }}
        >
          <div className="rounded-lg border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900">
            <MailRecipientFields
              ref={fieldsRef}
              companyId={companyId}
              companySlug={companySlug}
              accountId={accountId}
              value={fields}
              onChange={setFields}
              participants={participants}
              selfAddress={selfAddress}
              blocked={blocked}
              className="pb-1"
            />
          </div>
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea
            label="Message"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            // Editing a draft almost always means changing its words.
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            {keptAttachments.map((a) => (
              <span
                key={a.index}
                className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <a
                  href={mailApi.attachmentUrl(companyId, draft.id, a.index)}
                  download={a.filename}
                  aria-label={`Download ${a.filename}`}
                  title={`Download ${a.filename}`}
                  className="flex min-w-0 items-center gap-1.5 rounded-sm hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-indigo-400"
                >
                  <Paperclip size={12} className="shrink-0 text-slate-400" />
                  <span className="max-w-40 truncate">{a.filename}</span>
                  <span className="shrink-0 text-slate-400">{formatBytes(a.size)}</span>
                </a>
                <button
                  type="button"
                  onClick={() => setKept((prev) => withoutAttachment(prev, a.index))}
                  className="text-slate-400 hover:text-red-500"
                  aria-label={`Remove ${a.filename}`}
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <AttachmentBar
              items={attach.items}
              uploading={attach.uploading}
              onAdd={attach.addFiles}
              onRemove={attach.remove}
            />
          </div>
          <FormError message={error} />
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                clearAttach();
                setKept(allAttachmentIndexes(attachmentCount));
                setFields(savedRecipients(draft));
                setSubject(draft.subject);
                setBody(draft.bodyText);
                setError(null);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== null || attach.uploading || !dirty}
              onClick={async () => {
                const recipients = fieldsRef.current?.commit() ?? fields;
                const problem = mailRecipientProblem(recipients);
                if (problem) {
                  setError(problem);
                  return;
                }
                setBusy("save");
                setError(null);
                try {
                  await save(recipients);
                  setEditing(false);
                  await onChanged();
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Save
            </Button>
            <Button size="sm" disabled={busy !== null || attach.uploading} onClick={onSend}>
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── handovers ─────────────────────────────

function HandoverCard({
  handover,
  companyId,
  companySlug,
  onChanged,
}: {
  handover: MailHandover;
  companyId: string;
  companySlug: string;
  onChanged: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [showResult, setShowResult] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const statusTone: Record<MailHandover["status"], BadgeTone> = {
    pending: "neutral",
    running: "accent",
    completed: "success",
    failed: "danger",
  };
  const progressLabel =
    handover.sourceKind === "rule" && handover.mode !== "triage"
      ? handover.mode === "work"
        ? "preparing work for review"
        : "preparing a reply for review"
      : handover.mode === "work"
        ? "doing the work and preparing a reply"
        : handover.mode === "draft"
          ? "preparing a reply for review"
          : handover.mode === "reply"
            ? "replying"
            : "triaging";
  return (
    <div
      id={`handover-${handover.id}`}
      tabIndex={-1}
      className="scroll-mt-4 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus dark:border-slate-800 dark:bg-slate-950"
    >
      <div className="flex items-center gap-2 text-sm">
        <Bot size={14} className="shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
          <span className="font-medium">{handover.employee?.name ?? "AI employee"}</span>
          {" · "}
          {progressLabel}
          {handover.sourceKind === "rule" && <span className="text-slate-400"> · via rule</span>}
        </span>
        <Badge
          tone={statusTone[handover.status]}
          icon={handover.status === "running" ? <Spinner size={9} /> : undefined}
        >
          {handover.status}
        </Badge>
        {handover.status === "failed" && (
          <Button
            size="sm"
            variant="ghost"
            loading={retrying}
            onClick={async () => {
              setRetrying(true);
              try {
                await mailApi.retryHandover(companyId, handover.id);
                await onChanged();
              } catch (err) {
                void dialog.error(err, { title: "Couldn’t retry the handover" });
              } finally {
                setRetrying(false);
              }
            }}
          >
            Retry
          </Button>
        )}
        {(handover.resultSummary || handover.errorMessage) && (
          <button
            onClick={() => setShowResult((v) => !v)}
            className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {showResult ? "Hide" : "Details"}
          </button>
        )}
      </div>
      {showResult && (
        <div className="mt-2 whitespace-pre-wrap break-words border-t border-slate-100 pt-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
          {handover.errorMessage || handover.resultSummary}
        </div>
      )}
      {handover.status === "completed" &&
        ((handover.sourceKind === "rule" && handover.mode !== "triage") ||
          handover.mode === "draft" ||
          handover.mode === "work") && (
          <Link
            to={`/c/${companySlug}/decisions`}
            className="mt-2 inline-flex text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Open Decision stack
          </Link>
        )}
    </div>
  );
}

function HandToAiModal({
  open,
  onClose,
  companyId,
  companySlug,
  accountId,
  threadId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  companySlug: string;
  accountId: string;
  threadId: string;
  onCreated: () => Promise<void>;
}) {
  const [grants, setGrants] = React.useState<MailGrant[] | null>(null);
  const [employeeId, setEmployeeId] = React.useState("");
  const [mode, setMode] = React.useState<MailHandoverMode>("draft");
  const [instruction, setInstruction] = React.useState(DEFAULT_INSTRUCTIONS.draft);
  const [instructionTouched, setInstructionTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setGrants(null);
    setError(null);
    setBusy(false);
    setMode("draft");
    setInstruction(DEFAULT_INSTRUCTIONS.draft);
    setInstructionTouched(false);
    mailApi
      .grants(companyId, accountId)
      .then((res) => {
        setGrants(res.direct);
        // Start on someone who can actually work the thread: a read-only
        // grant (enough for AI analysis) can't draft, and would leave Hand
        // over disabled until the Member picked someone else.
        const capable = res.direct.find((grant) => grant.accessLevel !== "read");
        setEmployeeId((capable ?? res.direct[0])?.employeeId ?? "");
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [open, companyId, accountId]);

  const selected = grants?.find((g) => g.employeeId === employeeId) ?? null;
  const levelRank: Record<MailAccessLevel, number> = { read: 0, draft: 1, send: 2 };
  const canDraft = selected ? levelRank[selected.accessLevel] >= 1 : false;
  const canSend = selected ? levelRank[selected.accessLevel] >= 2 : false;

  // If the chosen employee can't do the currently-selected mode (e.g. you
  // picked "reply" then switched to a draft-only employee), fall back to a
  // mode it can do so the server never rejects the handover.
  React.useEffect(() => {
    if (mode === "reply" && !canSend && canDraft) setMode("draft");
  }, [mode, canSend, canDraft]);

  const pickMode = (m: MailHandoverMode) => {
    setMode(m);
    if (!instructionTouched) setInstruction(DEFAULT_INSTRUCTIONS[m]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await mailApi.createHandover(companyId, threadId, {
        employeeId,
        instruction,
        mode,
      });
      onClose();
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Hand this thread to an AI employee">
      {grants === null ? (
        <div className="flex justify-center py-8">
          <Spinner size={20} />
        </div>
      ) : grants.length === 0 ? (
        <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
          <p>No AI employee has access to this mailbox yet.</p>
          <p>
            Grant access under{" "}
            <Link
              to={`/c/${companySlug}/mail/settings`}
              className="text-indigo-600 hover:underline dark:text-indigo-400"
              onClick={onClose}
            >
              Email → Settings → AI access
            </Link>
            , then come back here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <Select
            label="AI employee"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            {grants.map((g) => (
              <option key={g.employeeId} value={g.employeeId}>
                {g.employee?.name ?? "Unknown"} — {g.accessLevel} access
              </option>
            ))}
          </Select>
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
              What should happen
            </div>
            <div className="space-y-1.5">
              {(Object.keys(MODE_LABELS) as MailHandoverMode[]).map((m) => {
                const disabled =
                  (m === "reply" && !canSend) ||
                  ((m === "draft" || m === "triage" || m === "work") && !canDraft);
                return (
                  <label
                    key={m}
                    className={clsx(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                      mode === m
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200"
                        : "border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-300",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="handover-mode"
                      className="accent-indigo-600"
                      checked={mode === m}
                      disabled={disabled}
                      onChange={() => pickMode(m)}
                    />
                    {MODE_LABELS[m]}
                    {m === "reply" && !canSend && (
                      <span className="ml-auto text-xs text-slate-400">
                        needs &quot;send&quot; access
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
          <Textarea
            label="Instruction"
            rows={4}
            value={instruction}
            onChange={(e) => {
              setInstruction(e.target.value);
              setInstructionTouched(true);
            }}
          />
          {!canDraft && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {selected?.employee?.name ?? "This employee"} only has read access to this mailbox —
              grant &quot;draft&quot; or higher under Settings → AI access before handing over.
            </p>
          )}
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} disabled={!employeeId || !canDraft}>
              Hand over
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
