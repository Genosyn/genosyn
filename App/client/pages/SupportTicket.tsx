import { RecordTasks } from "@/components/todos/RecordTasks";
import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlarmClock,
  AlertTriangle,
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  FileText,
  GitMerge,
  Languages,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Reply,
  Send,
  ShieldOff,
  Sparkles,
  StickyNote,
  Star,
  Trash2,
  UserRound,
  Wand2,
  X,
} from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { AttachmentBar, useMailAttachments } from "@/components/MailAttachments";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { ApiError, api as http, type Employee, type Member } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  agoText,
  messageAuthor,
  readComposerDraft,
  requesterLabel,
  slaState,
  splitAddresses,
  supportApi,
  writeComposerDraft,
  type AssistAction,
  type SupportDraft,
  type SupportEvent,
  type SupportMessage,
  type SupportSavedReply,
  type SupportTicketDetail,
} from "@/lib/support";
import {
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_SENTIMENT_LABELS,
  SUPPORT_SETTABLE_STATUSES,
  SUPPORT_SOURCE_LABELS,
  SUPPORT_STATUS_LABELS,
  firstNameOf,
  renderSavedReply,
  ticketReference,
  type SupportPriority,
  type SupportSettableStatus,
} from "../../shared/support";
import type { SupportOutletContext } from "./SupportLayout";
import { PRIORITY_TONE } from "./SupportQueue";
import { EmailBody } from "./support/EmailBody";

const ASSIST_ACTIONS: Array<{ action: AssistAction; label: string }> = [
  { action: "clearer", label: "Fix grammar and clarity" },
  { action: "shorter", label: "Make it shorter" },
  { action: "friendlier", label: "Make it friendlier" },
  { action: "formal", label: "Make it more formal" },
  { action: "translate", label: "Translate to the customer's language" },
];

const SNOOZES: Array<{ label: string; hours: number }> = [
  { label: "For 4 hours", hours: 4 },
  { label: "Until tomorrow", hours: 24 },
  { label: "For 3 days", hours: 72 },
  { label: "For a week", hours: 168 },
];

/** One line of a ticket's timeline, in plain words. */
function eventText(event: SupportEvent, topicName: (key: string | null) => string): string | null {
  const data = event.data;
  const who = event.actorName;
  switch (event.kind) {
    case "created":
      if (data.source === "chat") return "Started in the chat widget";
      return data.source === "import" ? "Imported from the mailbox" : null;
    case "status_changed": {
      const to =
        SUPPORT_STATUS_LABELS[data.to as keyof typeof SUPPORT_STATUS_LABELS] ?? String(data.to);
      const because = data.reason ? `: ${String(data.reason)}` : "";
      return `${who} set this to ${to.toLowerCase()}${because}`;
    }
    case "priority_changed":
      return `${who} set the priority to ${String(data.to)}`;
    case "topic_changed":
      return `${who} set the topic to ${topicName((data.to as string) ?? null)}`;
    case "assigned":
      return data.userId || data.employeeId
        ? `${who} assigned this${data.reason ? ` (${String(data.reason)})` : ""}`
        : `${who} unassigned this`;
    case "tags_changed":
      return `${who} changed the tags`;
    case "subject_changed":
      return `${who} changed the subject`;
    case "merged_in":
      return `${who} merged ticket ${ticketReference(Number(data.number))} into this one`;
    case "merged_into":
      return `${who} merged this into ${ticketReference(Number(data.number))}`;
    case "reopened":
      return `${who} wrote again, so this reopened`;
    case "ai_triaged":
      return null;
    case "ai_drafted":
      return `${who} drafted a reply`;
    case "ai_replied":
      return `${who} replied on its own`;
    case "ai_held": {
      const reasons = Array.isArray(data.reasons) ? (data.reasons as string[]) : [];
      return `${who} held its reply for a person${reasons.length ? `: ${reasons[0]}` : ""}`;
    }
    case "ai_failed":
      return `${who} could not finish its work`;
    case "handed_over":
      return `${who} handed this to ${String(data.employeeName ?? "an AI Employee")}`;
    case "sla_breached":
      return "A target was missed";
    case "rated":
      return `${who} rated this ${String(data.score)} of 5`;
    case "delivery_failed":
      return "A reply could not be delivered";
    case "acknowledged":
      return "The customer was sent an acknowledgement";
    case "rating_requested":
      return "The customer was asked for a rating";
    case "chat_email_confirmed":
      return `${who} confirmed ${String(data.address ?? "their address")}, so replies they miss go there`;
    case "chat_ended":
      return `${who} ended the chat`;
    default:
      return null;
  }
}

/** Where a reply on a chat ticket goes, in the composer's few words. */
function chatReplyHint(chat: NonNullable<SupportTicketDetail["chat"]>): string {
  if (!chat.reachable) return "Nothing can reach this visitor now";
  if (chat.email) return `In the chat, then ${chat.email} if they miss it`;
  return "In the chat, if they come back";
}

function PersonAvatar({ companyId, message }: { companyId: string; message: SupportMessage }) {
  if (message.authorEmployee || message.sentByAi) {
    return (
      <Avatar
        name={message.authorEmployee?.name ?? "AI Employee"}
        src={
          message.authorEmployee
            ? employeeAvatarUrl(
                companyId,
                message.authorEmployee.id,
                message.authorEmployee.avatarKey,
              )
            : null
        }
        kind="ai"
        size="sm"
      />
    );
  }
  if (message.authorUser) {
    return (
      <Avatar
        name={message.authorUser.name}
        src={memberAvatarUrl(companyId, message.authorUser.id, message.authorUser.avatarKey)}
        size="sm"
      />
    );
  }
  return <Avatar name={messageAuthor(message)} size="sm" />;
}

function Citations({
  draftOrMessage,
  slug,
}: {
  draftOrMessage: { citations: SupportDraft["citations"] };
  slug: string;
}) {
  if (draftOrMessage.citations.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {draftOrMessage.citations.map((citation) => (
        <li key={`${citation.articleId}:${citation.quote}`} className="flex gap-1.5 text-xs">
          <BookOpen size={12} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span className="min-w-0 text-slate-500 dark:text-slate-400">
            <Link
              to={`/c/${slug}/support/knowledge/${citation.articleId}`}
              className="font-medium text-slate-700 hover:underline dark:text-slate-300"
            >
              {citation.title}
            </Link>
            : &ldquo;{citation.quote}&rdquo;
          </span>
        </li>
      ))}
    </ul>
  );
}

function MessageCard({
  message,
  companyId,
  slug,
  ticketId,
}: {
  message: SupportMessage;
  companyId: string;
  slug: string;
  ticketId: string;
}) {
  const api = supportApi(companyId);
  if (message.kind === "automated") {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 dark:border-slate-700">
        <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {message.viaChat
              ? "Automatic message in the chat"
              : message.fromEmail && message.authorUser === null && message.authorEmployee === null
                ? `Automatic email · ${message.fromName || message.fromEmail}`
                : "Automatic email"}
          </span>
          <span className="tabular-nums">{agoText(message.sentAt)}</span>
        </div>
        <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500 dark:text-slate-400">
          {message.cleanText || message.bodyText}
        </p>
      </div>
    );
  }
  const isNote = message.kind === "note";
  const isTeam = message.kind === "reply";
  return (
    <article
      className={clsx(
        "rounded-xl border p-4 shadow-sm",
        isNote
          ? "border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10"
          : isTeam
            ? "border-indigo-100 bg-indigo-50/40 dark:border-indigo-500/20 dark:bg-indigo-500/5"
            : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <PersonAvatar companyId={companyId} message={message} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {messageAuthor(message)}
              </span>
              {isNote && <Badge tone="warning">Internal note</Badge>}
              {message.sentByAi && (
                <Badge tone="ai" icon={<Bot />}>
                  Sent by AI
                </Badge>
              )}
              {!message.sentByAi && message.authorEmployee && !isNote && (
                <Badge tone="ai">AI Employee</Badge>
              )}
              {message.viaChat && (
                <Badge tone="info" icon={<MessageCircle />}>
                  Chat
                </Badge>
              )}
            </div>
            {!isNote && !message.viaChat && (
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {message.fromEmail}
                {message.ccEmails ? ` · cc ${message.ccEmails}` : ""}
              </div>
            )}
          </div>
        </div>
        <time
          className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400"
          dateTime={message.sentAt}
          title={new Date(message.sentAt).toLocaleString()}
        >
          {agoText(message.sentAt)}
        </time>
      </header>
      {message.kind === "customer" ? (
        <EmailBody
          cleanText={message.cleanText}
          bodyText={message.bodyText}
          bodyHtml={message.bodyHtml}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 dark:text-slate-200">
          {message.cleanText || message.bodyText}
        </p>
      )}
      {message.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {message.attachments.map((file, index) => (
            <li key={`${file.filename}:${index}`}>
              <a
                href={api.attachmentUrl(ticketId, message.id, index)}
                className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Download size={12} className="shrink-0" />
                <span className="truncate">{file.filename}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <Citations draftOrMessage={message} slug={slug} />
    </article>
  );
}

function DraftCard({
  draft,
  detail,
  slug,
  busy,
  onSend,
  onEdit,
  onDiscard,
  onRetry,
  error,
  staleConflict,
  onForce,
}: {
  draft: SupportDraft;
  detail: SupportTicketDetail;
  slug: string;
  busy: "send" | "discard" | "retry" | null;
  onSend: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  error: string;
  staleConflict: boolean;
  onForce: () => void;
}) {
  const [showTranslation, setShowTranslation] = React.useState(false);
  const mode = detail.inbox?.aiMode;
  const ready = draft.holdReasons.length === 0;
  return (
    <Card className="border-violet-200 dark:border-violet-500/30">
      <div className="flex flex-wrap items-center gap-2 border-b border-violet-100 px-4 py-2.5 dark:border-violet-500/20">
        <Sparkles size={14} className="text-violet-600 dark:text-violet-300" aria-hidden="true" />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {draft.employee?.name ?? "Your AI Employee"} drafted a reply
        </span>
        <Badge
          tone={
            draft.confidence === "high"
              ? "success"
              : draft.confidence === "medium"
                ? "info"
                : "warning"
          }
        >
          {draft.confidence === "high"
            ? "High confidence"
            : draft.confidence === "medium"
              ? "Medium confidence"
              : "Low confidence"}
        </Badge>
        {draft.injectionDetected && (
          <Badge tone="danger" icon={<AlertTriangle />}>
            The email tried to instruct the AI
          </Badge>
        )}
        {draft.translation && (
          <button
            type="button"
            onClick={() => setShowTranslation((value) => !value)}
            className="touch-target relative ml-auto inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <Languages size={12} /> {showTranslation ? "Show original" : "Show translation"}
          </button>
        )}
      </div>
      <div className="p-4">
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 dark:text-slate-200">
          {showTranslation ? draft.translation : draft.body}
        </p>
        <Citations draftOrMessage={draft} slug={slug} />
        {draft.citations.length === 0 && !draft.answerable && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            No Article covers this.{" "}
            <Link to={`/c/${slug}/support/knowledge/new`} className="font-medium underline">
              Write one
            </Link>{" "}
            and the next customer gets an answer.
          </p>
        )}
        {draft.note && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {draft.note}
          </p>
        )}
        {ready ? (
          mode !== "auto" && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={12} /> Every check passed. On &ldquo;Reply on its own&rdquo; this
              would have gone out by itself.
            </p>
          )
        ) : (
          <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            <div className="font-medium text-slate-600 dark:text-slate-300">
              {mode === "auto" ? "Held for a person because:" : "Would wait for a person because:"}
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {draft.holdReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        <FormError message={error} className="mt-3" />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {staleConflict ? (
            <Button loading={busy === "send"} onClick={onForce}>
              <Send size={14} /> Send anyway
            </Button>
          ) : (
            <Button loading={busy === "send"} disabled={busy !== null} onClick={onSend}>
              <Send size={14} /> Send
            </Button>
          )}
          <Button variant="secondary" disabled={busy !== null} onClick={onEdit}>
            Edit first
          </Button>
          <Button
            variant="ghost"
            loading={busy === "retry"}
            disabled={busy !== null}
            onClick={onRetry}
          >
            <RefreshCw size={14} /> Try again
          </Button>
          <Button
            variant="ghost"
            loading={busy === "discard"}
            disabled={busy !== null}
            onClick={onDiscard}
          >
            <Trash2 size={14} /> Discard
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{title}</h2>
      {children}
    </section>
  );
}

/** One ticket: its conversation, what the AI made of it, and the reply being written. */
export default function SupportTicketPage() {
  const { company, topics, inboxes, reload: reloadRail } = useOutletContext<SupportOutletContext>();
  const { ticketId = "" } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [detail, setDetail] = React.useState<SupportTicketDetail | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [members, setMembers] = React.useState<Member[]>([]);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [savedReplies, setSavedReplies] = React.useState<SupportSavedReply[]>([]);
  const [myName, setMyName] = React.useState("");

  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [body, setBody] = React.useState("");
  const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null);
  const [ccText, setCcText] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [assisting, setAssisting] = React.useState(false);
  const [composerError, setComposerError] = React.useState("");
  const [stale, setStale] = React.useState(false);
  const [draftBusy, setDraftBusy] = React.useState<"send" | "discard" | "retry" | null>(null);
  const [draftError, setDraftError] = React.useState("");
  const [draftStale, setDraftStale] = React.useState(false);
  const [merging, setMerging] = React.useState(false);
  const [handingOver, setHandingOver] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);

  const load = React.useCallback(async () => {
    try {
      setDetail(await api.ticket(ticketId));
      setLoadError("");
    } catch (err) {
      setLoadError(errorMessage(err, "This ticket could not be loaded"));
    }
  }, [api, ticketId]);

  React.useEffect(() => {
    setDetail(null);
    setBody(readComposerDraft(ticketId));
    setEditingDraftId(null);
    setMode("reply");
    setCcText(null);
    setComposerError("");
    setStale(false);
    setDraftError("");
    setDraftStale(false);
    void load();
  }, [ticketId, load]);
  useLiveRefetch("support_ticket", () => void load(), ticketId);

  React.useEffect(() => {
    let live = true;
    void Promise.all([
      http.get<Member[]>(`/api/companies/${company.id}/members`).catch(() => [] as Member[]),
      http.get<Employee[]>(`/api/companies/${company.id}/employees`).catch(() => [] as Employee[]),
      api.savedReplies().catch(() => ({ savedReplies: [] as SupportSavedReply[] })),
      http.get<{ name?: string; email?: string }>("/api/auth/me").catch(() => null),
    ]).then(([memberRows, employeeRows, saved, me]) => {
      if (!live) return;
      setMembers(memberRows);
      setEmployees(employeeRows);
      setSavedReplies(saved.savedReplies);
      setMyName(me?.name || me?.email || "");
    });
    return () => {
      live = false;
    };
  }, [api, company.id]);

  const attachments = useMailAttachments(company.id, detail?.mailbox?.id ?? "");

  const topicName = React.useCallback(
    (key: string | null) => topics.find((topic) => topic.key === key)?.name ?? "Not set",
    [topics],
  );

  const ticket = detail?.ticket ?? null;
  const readyDraft = detail?.drafts.find((draft) => draft.status === "ready") ?? null;
  const lastSpoken = detail
    ? [...detail.messages]
        .reverse()
        .find((message) => message.kind === "customer" || message.kind === "reply")
    : null;
  const workRunning = detail?.work?.status === "queued" || detail?.work?.status === "running";

  /** Change the ticket; the page re-renders from the server's answer. */
  async function change(patch: Parameters<typeof api.updateTicket>[1]) {
    setSaving(true);
    try {
      await api.updateTicket(ticketId, patch);
      await Promise.all([load(), reloadRail()]);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update this ticket" });
    } finally {
      setSaving(false);
    }
  }

  function updateBody(text: string) {
    setBody(text);
    if (!editingDraftId) writeComposerDraft(ticketId, text);
  }

  async function send(options: { force?: boolean; status?: SupportSettableStatus } = {}) {
    if (!body.trim()) return;
    setSending(true);
    setComposerError("");
    setStale(false);
    try {
      if (mode === "note") {
        await api.note(ticketId, body.trim());
      } else if (editingDraftId) {
        await api.sendDraft(ticketId, editingDraftId, {
          body: body.trim(),
          cc: ccText === null ? undefined : splitAddresses(ccText),
          attachmentIds: attachments.ids,
          status: options.status,
          basedOnMessageId: lastSpoken?.id ?? null,
          force: options.force,
        });
      } else {
        await api.reply(ticketId, {
          body: body.trim(),
          cc: ccText === null ? undefined : splitAddresses(ccText),
          attachmentIds: attachments.ids,
          status: options.status,
          basedOnMessageId: lastSpoken?.id ?? null,
          force: options.force,
        });
      }
      setBody("");
      writeComposerDraft(ticketId, "");
      setEditingDraftId(null);
      setCcText(null);
      attachments.clear();
      // The mode stays: a second note must not quietly become an email to the customer.
      await Promise.all([load(), reloadRail()]);
    } catch (err) {
      setComposerError(errorMessage(err, "This did not send"));
      const stale =
        err instanceof ApiError && (err.data as { code?: string } | null)?.code === "stale";
      setStale(stale);
      // They were just told to read it, and the live update may never have reached them.
      if (stale) void load();
    } finally {
      setSending(false);
    }
  }

  async function sendDraftAsIs(force?: boolean) {
    if (!readyDraft) return;
    setDraftBusy("send");
    setDraftError("");
    setDraftStale(false);
    try {
      await api.sendDraft(ticketId, readyDraft.id, {
        basedOnMessageId: lastSpoken?.id ?? null,
        force,
      });
      await Promise.all([load(), reloadRail()]);
    } catch (err) {
      setDraftError(errorMessage(err, "This did not send"));
      const stale =
        err instanceof ApiError && (err.data as { code?: string } | null)?.code === "stale";
      setDraftStale(stale);
      if (stale) void load();
    } finally {
      setDraftBusy(null);
    }
  }

  async function discardReadyDraft() {
    if (!readyDraft) return;
    setDraftBusy("discard");
    try {
      await api.discardDraft(ticketId, readyDraft.id);
      await Promise.all([load(), reloadRail()]);
    } catch (err) {
      setDraftError(errorMessage(err, "Could not discard this draft"));
    } finally {
      setDraftBusy(null);
    }
  }

  async function askAi() {
    setDraftBusy("retry");
    setDraftError("");
    try {
      await api.askAi(ticketId);
      await load();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t ask the AI Employee" });
    } finally {
      setDraftBusy(null);
    }
  }

  async function assist(action: AssistAction) {
    if (!body.trim()) return;
    setAssisting(true);
    setComposerError("");
    try {
      const { text } = await api.assist(ticketId, body.trim(), action);
      updateBody(text);
    } catch (err) {
      setComposerError(errorMessage(err, "The rewrite did not work"));
    } finally {
      setAssisting(false);
    }
  }

  function insertSavedReply(reply: SupportSavedReply) {
    if (!ticket) return;
    const name = ticket.requesterName;
    const text = renderSavedReply(reply.body, {
      customerName: name,
      customerFirstName: firstNameOf(name),
      customerEmail: ticket.requesterEmail,
      ticketNumber: ticketReference(ticket.number),
      ticketSubject: ticket.subject,
      agentName: myName,
      companyName: company.name,
    });
    updateBody(body.trim() ? `${body.trim()}\n\n${text}` : text);
    void api.savedReplyUsed(reply.id).catch(() => undefined);
    composerRef.current?.focus();
  }

  async function articleFromTicket() {
    try {
      await api.articleFromTicket(ticketId);
      void dialog.alert({
        title: "Writing a draft Article",
        message:
          "Your AI Employee is writing a draft from this conversation. It appears under Knowledge for you to review. Nothing is published until someone does.",
      });
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start the Article" });
    }
  }

  // R replies, N writes a note and E solves, for someone working down a queue.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "r") {
        event.preventDefault();
        setMode("reply");
        composerRef.current?.focus();
      } else if (event.key === "n") {
        event.preventDefault();
        setMode("note");
        composerRef.current?.focus();
      } else if (event.key === "e" && ticket && ticket.status !== "solved") {
        event.preventDefault();
        void change({ status: "solved" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.status, ticketId]);

  if (loadError && !detail) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <EmptyState
          title="This ticket could not be loaded"
          description={loadError}
          action={
            <Button onClick={() => navigate(`/c/${company.slug}/support`)}>Back to Support</Button>
          }
        />
      </div>
    );
  }
  if (!detail || !ticket) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <Skeleton className="mb-4 h-7 w-2/3" />
        <SkeletonList rows={4} />
      </div>
    );
  }

  const sla = slaState(ticket);
  const assigneeValue = ticket.assigneeUser
    ? `user:${ticket.assigneeUser.id}`
    : ticket.assigneeEmployee
      ? `employee:${ticket.assigneeEmployee.id}`
      : "";
  const timeline = [
    ...detail.messages.map((message) => ({
      at: message.sentAt,
      message,
      event: null as SupportEvent | null,
    })),
    ...detail.events.map((event) => ({
      at: event.createdAt,
      message: null as SupportMessage | null,
      event,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const canReply = ticket.status !== "spam" && !ticket.mergedIntoId;

  return (
    <div className="page-shell p-4 sm:p-6">
      <div className="mb-3">
        <Breadcrumbs
          items={[
            { label: "Support", to: `/c/${company.slug}/support` },
            { label: ticketReference(ticket.number) },
          ]}
        />
      </div>
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl dark:text-slate-100">
            {ticket.subject || "(no subject)"}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            <span>
              {requesterLabel(ticket)}
              {ticket.requesterName && ticket.requesterEmail ? ` <${ticket.requesterEmail}>` : ""}
            </span>
            <Badge
              tone={ticket.status === "new" || ticket.status === "open" ? "accent" : "neutral"}
            >
              {SUPPORT_STATUS_LABELS[ticket.status]}
            </Badge>
            {ticket.source === "chat" && (
              <Badge tone="info" icon={<MessageCircle />}>
                Chat widget
              </Badge>
            )}
            {ticket.priority !== "normal" && (
              <Badge tone={PRIORITY_TONE[ticket.priority]}>
                {SUPPORT_PRIORITY_LABELS[ticket.priority]}
              </Badge>
            )}
            {sla && (
              <Badge tone={sla.tone} icon={<AlarmClock />}>
                {sla.label}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {ticket.status === "spam" ? (
            <Button
              variant="secondary"
              loading={saving}
              onClick={() => void change({ status: "open" })}
            >
              Not spam
            </Button>
          ) : ticket.status === "solved" || ticket.status === "closed" ? (
            <Button
              variant="secondary"
              loading={saving}
              onClick={() => void change({ status: "open" })}
            >
              Reopen
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={saving}
              onClick={() => void change({ status: "solved" })}
            >
              <CheckCircle2 size={14} /> Solve
            </Button>
          )}
          <Menu
            align="right"
            trigger={({ ref, onClick, open }) => (
              <Button ref={ref} variant="secondary" onClick={onClick} aria-expanded={open}>
                <Clock size={14} /> Snooze <ChevronDown size={13} />
              </Button>
            )}
          >
            {(close) =>
              SNOOZES.map((snooze) => (
                <MenuItem
                  key={snooze.hours}
                  label={snooze.label}
                  onSelect={() => {
                    close();
                    void change({
                      status: "snoozed",
                      snoozedUntil: new Date(Date.now() + snooze.hours * 3_600_000).toISOString(),
                    });
                  }}
                />
              ))
            }
          </Menu>
          <Menu
            align="right"
            width={260}
            trigger={({ ref, onClick, open }) => (
              <Button
                ref={ref}
                variant="secondary"
                onClick={onClick}
                aria-expanded={open}
                aria-label="More actions"
              >
                <MoreHorizontal size={14} />
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Sparkles size={14} />}
                  label={readyDraft ? "Draft a new reply" : "Ask for a draft"}
                  onSelect={() => {
                    close();
                    void askAi();
                  }}
                />
                {(ticket.source !== "chat" || detail.mailbox) && (
                  <MenuItem
                    icon={<Bot size={14} />}
                    label="Hand to an AI Employee"
                    hint="With its Skills and tools"
                    onSelect={() => {
                      close();
                      setHandingOver(true);
                    }}
                  />
                )}
                <MenuItem
                  icon={<FileText size={14} />}
                  label="Write an Article from this"
                  onSelect={() => {
                    close();
                    void articleFromTicket();
                  }}
                />
                <MenuSeparator />
                <MenuItem
                  icon={<GitMerge size={14} />}
                  label="Merge into another ticket"
                  onSelect={() => {
                    close();
                    setMerging(true);
                  }}
                />
                <MenuItem
                  icon={<ShieldOff size={14} />}
                  label="Mark as spam"
                  onSelect={() => {
                    close();
                    void change({ status: "spam" });
                  }}
                />
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          {ticket.mergedIntoId && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
              This ticket was merged.{" "}
              <Link
                to={`/c/${company.slug}/support/tickets/${ticket.mergedIntoId}`}
                className="font-medium underline"
              >
                Open the ticket it joined
              </Link>
            </div>
          )}
          {ticket.status === "spam" && ticket.spamReason && (
            <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
              <ShieldOff size={15} className="mt-0.5 shrink-0" />
              <span>Filed as spam: {ticket.spamReason}</span>
            </div>
          )}
          {ticket.aiSummary && (
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-300">
                <Sparkles size={12} /> AI summary
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-800 dark:text-slate-200">
                {ticket.aiSummary}
              </p>
              {ticket.aiNextStep && (
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  <span className="font-medium">Next: </span>
                  {ticket.aiNextStep}
                </p>
              )}
              {ticket.needsHuman && (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Needs a person{ticket.aiHandoffReason ? `: ${ticket.aiHandoffReason}` : ""}
                  </span>
                </p>
              )}
            </Card>
          )}

          <div className="space-y-2.5" aria-label="Conversation">
            {timeline.map((entry) => {
              if (entry.message) {
                return (
                  <MessageCard
                    key={`m-${entry.message.id}`}
                    message={entry.message}
                    companyId={company.id}
                    slug={company.slug}
                    ticketId={ticket.id}
                  />
                );
              }
              const text = entry.event ? eventText(entry.event, topicName) : null;
              if (!text || !entry.event) return null;
              return (
                <div
                  key={`e-${entry.event.id}`}
                  className="flex items-center gap-2 px-1 text-xs text-slate-500 dark:text-slate-400"
                >
                  <span
                    className="h-px w-3 shrink-0 bg-slate-200 dark:bg-slate-700"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">{text}</span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {agoText(entry.event.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>

          {workRunning && !readyDraft && (
            <div className="flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-3 text-sm text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
              <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" />
              {detail.inbox?.aiEmployeeName ?? "Your AI Employee"} is reading this ticket.
              {detail.work?.error ? <span className="opacity-80"> {detail.work.error}</span> : null}
            </div>
          )}
          {detail.work?.status === "failed" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <span className="flex min-w-0 items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{detail.work.error || "The AI Employee could not finish this ticket."}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={draftBusy === "retry"}
                onClick={() => void askAi()}
              >
                Try again
              </Button>
            </div>
          )}

          {readyDraft && editingDraftId !== readyDraft.id && (
            <DraftCard
              draft={readyDraft}
              detail={detail}
              slug={company.slug}
              busy={draftBusy}
              error={draftError}
              staleConflict={draftStale}
              onForce={() => void sendDraftAsIs(true)}
              onSend={() => void sendDraftAsIs()}
              onDiscard={() => void discardReadyDraft()}
              onRetry={() => void askAi()}
              onEdit={() => {
                setEditingDraftId(readyDraft.id);
                setBody(readyDraft.body);
                setMode("reply");
                composerRef.current?.focus();
              }}
            />
          )}

          {canReply && (
            <Card>
              <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-1.5 dark:border-slate-800">
                <button
                  type="button"
                  aria-pressed={mode === "reply"}
                  onClick={() => setMode("reply")}
                  className={clsx(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium",
                    mode === "reply"
                      ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
                  )}
                >
                  <Reply size={14} /> Reply
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "note"}
                  onClick={() => setMode("note")}
                  className={clsx(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium",
                    mode === "note"
                      ? "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
                  )}
                >
                  <StickyNote size={14} /> Note
                </button>
                <span className="ml-auto truncate px-2 text-xs text-slate-500 dark:text-slate-400">
                  {mode === "note"
                    ? "Only your team sees this"
                    : detail.chat
                      ? chatReplyHint(detail.chat)
                      : `To ${ticket.requesterEmail}`}
                </span>
              </div>
              {mode === "reply" && ticket.cc.length + (ccText === null ? 0 : 1) > 0 && (
                <div className="border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
                  <Input
                    aria-label="Cc"
                    placeholder="Cc"
                    className="border-0 shadow-none focus:ring-0"
                    value={ccText ?? ticket.cc.join(", ")}
                    onChange={(event) => setCcText(event.target.value)}
                  />
                </div>
              )}
              <Textarea
                ref={composerRef}
                aria-label={mode === "note" ? "Internal note" : "Reply"}
                placeholder={
                  mode === "note"
                    ? "Write a note for your team"
                    : `Write to ${firstNameOf(ticket.requesterName) || requesterLabel(ticket)}`
                }
                rows={5}
                value={body}
                className="rounded-none border-0 shadow-none focus:ring-0"
                onChange={(event) => updateBody(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                {mode === "reply" && detail.mailbox && !detail.chat && (
                  <AttachmentBar
                    items={attachments.items}
                    uploading={attachments.uploading}
                    onAdd={(files) => void attachments.addFiles(files)}
                    onRemove={attachments.remove}
                  />
                )}
                {mode === "reply" && savedReplies.length > 0 && (
                  <Menu
                    width={280}
                    side="top"
                    trigger={({ ref, onClick, open }) => (
                      <Button
                        ref={ref}
                        size="sm"
                        variant="ghost"
                        onClick={onClick}
                        aria-expanded={open}
                      >
                        <MessageSquare size={13} /> Saved replies
                      </Button>
                    )}
                  >
                    {(close) =>
                      savedReplies.map((reply) => (
                        <MenuItem
                          key={reply.id}
                          label={reply.name}
                          onSelect={() => {
                            close();
                            insertSavedReply(reply);
                          }}
                        />
                      ))
                    }
                  </Menu>
                )}
                {mode === "reply" && (
                  <Menu
                    width={280}
                    side="top"
                    trigger={({ ref, onClick, open }) => (
                      <Button
                        ref={ref}
                        size="sm"
                        variant="ghost"
                        loading={assisting}
                        disabled={!body.trim()}
                        onClick={onClick}
                        aria-expanded={open}
                      >
                        <Wand2 size={13} /> Rewrite
                      </Button>
                    )}
                  >
                    {(close) =>
                      ASSIST_ACTIONS.map((item) => (
                        <MenuItem
                          key={item.action}
                          label={item.label}
                          onSelect={() => {
                            close();
                            void assist(item.action);
                          }}
                        />
                      ))
                    }
                  </Menu>
                )}
                {editingDraftId && (
                  <button
                    type="button"
                    className="touch-target relative inline-flex items-center gap-1 text-xs text-violet-700 hover:underline dark:text-violet-300"
                    onClick={() => {
                      setEditingDraftId(null);
                      setBody("");
                    }}
                  >
                    <X size={12} /> Editing the AI&apos;s draft
                  </button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {mode === "reply" && (
                    <Button
                      variant="secondary"
                      disabled={!body.trim() || sending}
                      onClick={() => void send({ status: "solved", force: stale })}
                    >
                      <CheckCircle2 size={14} /> Send and solve
                    </Button>
                  )}
                  <Button
                    loading={sending}
                    disabled={!body.trim()}
                    onClick={() => void send({ force: stale })}
                  >
                    {mode === "note" ? <StickyNote size={14} /> : <Send size={14} />}
                    {mode === "note" ? "Add note" : stale ? "Send anyway" : "Send"}
                  </Button>
                </div>
              </div>
              {composerError && <FormError message={composerError} className="mx-3 mb-3" />}
            </Card>
          )}
        </div>

        <aside className="space-y-5" aria-label="Ticket details">
          <RecordTasks
            companyId={company.id}
            companySlug={company.slug}
            kind="ticket"
            targetId={ticket.id}
            what="this ticket"
            suggestedTitle={ticket.subject}
          />
          <Card className="space-y-3 p-4">
            <Select
              label="Status"
              disabled={saving || ticket.status === "spam"}
              value={
                SUPPORT_SETTABLE_STATUSES.includes(ticket.status as SupportSettableStatus)
                  ? ticket.status
                  : "open"
              }
              onChange={(event) => {
                const status = event.target.value as SupportSettableStatus;
                if (status === "snoozed") {
                  void change({
                    status,
                    snoozedUntil: new Date(Date.now() + 24 * 3_600_000).toISOString(),
                  });
                } else {
                  void change({ status });
                }
              }}
            >
              {SUPPORT_SETTABLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {SUPPORT_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
            <Select
              label="Assignee"
              disabled={saving}
              value={assigneeValue}
              onChange={(event) => {
                const [kind, id] = event.target.value.split(":");
                void change({
                  assigneeUserId: kind === "user" ? id : null,
                  assigneeEmployeeId: kind === "employee" ? id : null,
                });
              }}
            >
              <option value="">Nobody</option>
              <optgroup label="Members">
                {members.map((member) => (
                  <option key={member.userId} value={`user:${member.userId}`}>
                    {member.name || member.email || "Member"}
                  </option>
                ))}
              </optgroup>
              <optgroup label="AI Employees">
                {employees.map((employee) => (
                  <option key={employee.id} value={`employee:${employee.id}`}>
                    {employee.name}
                  </option>
                ))}
              </optgroup>
            </Select>
            <Select
              label="Priority"
              disabled={saving}
              value={ticket.priority}
              onChange={(event) => void change({ priority: event.target.value as SupportPriority })}
            >
              {[...SUPPORT_PRIORITIES].reverse().map((priority) => (
                <option key={priority} value={priority}>
                  {SUPPORT_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </Select>
            <Select
              label="Topic"
              disabled={saving}
              value={ticket.topicKey ?? ""}
              onChange={(event) => void change({ topicKey: event.target.value || null })}
            >
              <option value="">Not set</option>
              {topics.map((topic) => (
                <option key={topic.key} value={topic.key}>
                  {topic.name}
                </option>
              ))}
            </Select>
            <TagEditor
              tags={ticket.tags}
              disabled={saving}
              onChange={(tags) => void change({ tags })}
            />
          </Card>

          <SideSection title="Customer">
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100">
                <UserRound size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                <span className="truncate">{requesterLabel(ticket)}</span>
              </div>
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {ticket.requesterEmail}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                From: {SUPPORT_SOURCE_LABELS[ticket.source]}
                {detail.inbox ? ` · ${detail.inbox.name}` : ""}
              </div>
              {detail.chat?.unconfirmedEmail && (
                <div className="break-words text-xs text-amber-700 dark:text-amber-400">
                  Typed {detail.chat.unconfirmedEmail}, not confirmed. Anyone can type any address.
                </div>
              )}
              {detail.chat && !detail.chat.reachable && (
                <div className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Nothing can reach this visitor now: the chat ended or the widget is off, and they
                  confirmed no email address.
                </div>
              )}
              {detail.customer && (
                <Link
                  to={`/c/${company.slug}/revenue/accounts/${detail.customer.id}`}
                  className="flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {detail.customer.name} <ExternalLink size={11} />
                </Link>
              )}
              {detail.contact && (
                <Link
                  to={`/c/${company.slug}/revenue/contacts/${detail.contact.id}`}
                  className="flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {detail.contact.name || "Contact"}
                  {detail.contact.title ? `, ${detail.contact.title}` : ""}{" "}
                  <ExternalLink size={11} />
                </Link>
              )}
              {detail.contact?.doNotContact && <Badge tone="danger">Do not contact</Badge>}
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                {ticket.sentiment && (
                  <>
                    <dt>Sounds</dt>
                    <dd className="text-slate-700 dark:text-slate-300">
                      {SUPPORT_SENTIMENT_LABELS[ticket.sentiment]}
                    </dd>
                  </>
                )}
                {ticket.language && (
                  <>
                    <dt>Writes in</dt>
                    <dd className="text-slate-700 dark:text-slate-300">{ticket.language}</dd>
                  </>
                )}
                {ticket.matchedAddress && (
                  <>
                    <dt>Wrote to</dt>
                    <dd className="truncate text-slate-700 dark:text-slate-300">
                      {ticket.matchedAddress}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </SideSection>

          {ticket.ratingScore !== null && (
            <SideSection title="Their rating">
              <div
                className="flex items-center gap-0.5"
                aria-label={`${ticket.ratingScore} of 5`}
                role="img"
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <Star
                    key={value}
                    size={14}
                    aria-hidden="true"
                    className={
                      value <= (ticket.ratingScore ?? 0)
                        ? "fill-amber-400 text-amber-400"
                        : "text-slate-300 dark:text-slate-600"
                    }
                  />
                ))}
              </div>
              {ticket.ratingComment && (
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {ticket.ratingComment}
                </p>
              )}
            </SideSection>
          )}

          {(ticket.firstResponseDueAt || ticket.resolutionDueAt) && (
            <SideSection title="Targets">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                <dt>First reply</dt>
                <dd className="text-slate-700 dark:text-slate-300">
                  {ticket.firstRespondedAt
                    ? `Answered ${agoText(ticket.firstRespondedAt)}`
                    : ticket.firstResponseDueAt
                      ? new Date(ticket.firstResponseDueAt).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "No target"}
                </dd>
                <dt>Solve by</dt>
                <dd className="text-slate-700 dark:text-slate-300">
                  {ticket.solvedAt
                    ? `Solved ${agoText(ticket.solvedAt)}`
                    : ticket.resolutionDueAt
                      ? new Date(ticket.resolutionDueAt).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "No target"}
                </dd>
              </dl>
            </SideSection>
          )}

          {detail.otherTickets.length > 0 && (
            <SideSection title="Their other tickets">
              <ul className="space-y-1">
                {detail.otherTickets.map((other) => (
                  <li key={other.id} className="flex items-baseline justify-between gap-2 text-sm">
                    <Link
                      to={`/c/${company.slug}/support/tickets/${other.id}`}
                      className="min-w-0 truncate text-slate-700 hover:underline dark:text-slate-300"
                    >
                      {other.subject || `Ticket ${ticketReference(other.number)}`}
                    </Link>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {SUPPORT_STATUS_LABELS[other.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </SideSection>
          )}

          {detail.similar.length > 0 && (
            <SideSection title="Similar solved tickets">
              <ul className="space-y-2">
                {detail.similar.map((other) => (
                  <li key={other.id}>
                    <Link
                      to={`/c/${company.slug}/support/tickets/${other.id}`}
                      className="block text-sm text-slate-700 hover:underline dark:text-slate-300"
                    >
                      {other.subject}
                    </Link>
                    {other.aiSummary && (
                      <p className="line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                        {other.aiSummary}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </SideSection>
          )}

          {inboxes && inboxes.length > 1 && detail.inbox && (
            <SideSection title="Support inbox">
              <div className="text-sm text-slate-700 dark:text-slate-300">{detail.inbox.name}</div>
            </SideSection>
          )}
        </aside>
      </div>

      <MergeModal
        open={merging}
        onClose={() => setMerging(false)}
        companyId={company.id}
        ticketId={ticket.id}
        onMerged={(intoId) => {
          setMerging(false);
          void reloadRail();
          navigate(`/c/${company.slug}/support/tickets/${intoId}`);
        }}
      />
      <HandoverModal
        open={handingOver}
        onClose={() => setHandingOver(false)}
        companyId={company.id}
        ticketId={ticket.id}
        employees={employees}
        onDone={() => {
          setHandingOver(false);
          void load();
        }}
      />
    </div>
  );
}

function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [text, setText] = React.useState("");
  function add() {
    const tag = text.trim();
    setText("");
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      onChange([...tags, tag]);
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Tags</span>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            >
              {tag}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove tag ${tag}`}
                className="touch-target relative text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                onClick={() => onChange(tags.filter((existing) => existing !== tag))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        aria-label="Add a tag"
        placeholder="Add a tag"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

function MergeModal({
  open,
  onClose,
  companyId,
  ticketId,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  ticketId: string;
  onMerged: (intoId: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<
    Array<{ id: string; number: number; subject: string; requester: string }>
  >([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setError("");
  }, [open]);

  React.useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      supportApi(companyId)
        .tickets({ q: query.trim() }, { limit: 8 })
        .then((page) =>
          setResults(
            page.rows
              .filter((row) => row.id !== ticketId)
              .map((row) => ({
                id: row.id,
                number: row.number,
                subject: row.subject,
                requester: requesterLabel(row),
              })),
          ),
        )
        .catch((err: unknown) => setError(errorMessage(err, "Search failed")));
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query, companyId, ticketId]);

  async function merge(intoId: string) {
    setBusy(intoId);
    setError("");
    try {
      await supportApi(companyId).merge(ticketId, intoId);
      onMerged(intoId);
    } catch (err) {
      setError(errorMessage(err, "Could not merge these tickets"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge into another ticket"
      description="This ticket's conversation moves there, and later replies on it arrive there too."
    >
      <div className="space-y-3">
        <Input
          aria-label="Find a ticket"
          autoFocus
          placeholder="Search by subject, customer or #number"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <FormError message={error} />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {results.map((result) => (
            <li key={result.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {result.subject}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  #{result.number} · {result.requester}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === result.id}
                disabled={busy !== null}
                onClick={() => void merge(result.id)}
              >
                Merge
              </Button>
            </li>
          ))}
        </ul>
        {query.trim() && results.length === 0 && !error && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No other tickets match.</p>
        )}
      </div>
    </Modal>
  );
}

function HandoverModal({
  open,
  onClose,
  companyId,
  ticketId,
  employees,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  ticketId: string;
  employees: Employee[];
  onDone: () => void;
}) {
  const [employeeId, setEmployeeId] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setEmployeeId(employees[0]?.id ?? "");
    setInstruction("");
    setError("");
  }, [open, employees]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await supportApi(companyId).handover(ticketId, employeeId, instruction.trim());
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Could not hand this over"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Hand to an AI Employee"
      description="It works this conversation with its Soul, Skills and tools, then brings the reply it wants to send to your Decision stack for a person."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!employeeId}>
            Hand over
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="AI Employee"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.name} ({employee.role})
            </option>
          ))}
        </Select>
        <Textarea
          label="What should it do?"
          rows={4}
          placeholder="Look up their subscription in Stripe and prepare a reply about the failed charge."
          value={instruction}
          hint="It needs access to this mailbox, given under Email → Settings → AI access."
          onChange={(event) => setInstruction(event.target.value)}
        />
        <FormError message={error} />
      </div>
    </Modal>
  );
}
