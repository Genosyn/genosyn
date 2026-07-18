import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import createDOMPurify from "dompurify";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  ChevronDown,
  Forward,
  Image as ImageIcon,
  Mail,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import {
  MailAccessLevel,
  MailGrant,
  MailHandover,
  MailHandoverMode,
  MailMessage,
  MailThread,
  ThreadActionName,
  mailApi,
  shortMailDate,
} from "../lib/mail";
import { MailOutletCtx } from "./MailLayout";
import { MailAssistant } from "./MailAssistant";
import { Button } from "../components/ui/Button";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Menu, MenuHeader, MenuItem } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { AttachmentBar, useMailAttachments } from "../components/MailAttachments";
import { clsx } from "../components/ui/clsx";

/**
 * One conversation: messages (sanitized HTML, remote images blocked until
 * asked), drafts you or an AI employee wrote (edit → send), a reply
 * composer, thread actions, and the "Hand to AI" flow with the handover
 * timeline. Every mutation writes through to Gmail.
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
  draft: "Write a draft (human sends)",
  reply: "Reply directly (sends mail)",
  triage: "Triage only (labels / archive)",
};

const DEFAULT_INSTRUCTIONS: Record<MailHandoverMode, string> = {
  draft: "Draft a reply to this email in our usual tone.",
  reply: "Reply to this email.",
  triage: "Categorize this email with an appropriate label and archive it if no action is needed.",
};

export default function MailThreadView() {
  const { company, account, labels, changeTick, openCompose } = useOutletContext<MailOutletCtx>();
  const { threadId } = useParams();
  const { toast } = useToast();
  const navigate = useNavigate();

  const forward = React.useCallback(
    (m: MailMessage) => {
      openCompose({
        subject: /^fwd:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
        bodyText: forwardQuote(m),
      });
    },
    [openCompose],
  );

  const [thread, setThread] = React.useState<MailThread | null>(null);
  const [messages, setMessages] = React.useState<MailMessage[]>([]);
  const [handovers, setHandovers] = React.useState<MailHandover[]>([]);
  const [notFound, setNotFound] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [handOpen, setHandOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!threadId) return;
    try {
      const res = await mailApi.thread(company.id, threadId);
      setThread(res.thread);
      setMessages(res.messages);
      setHandovers(res.handovers);
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
      if ((err as Error).message.includes("not found")) setNotFound(true);
      else toast((err as Error).message, "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, threadId]);

  React.useEffect(() => {
    setThread(null);
    setNotFound(false);
    setExpanded(new Set());
    void load();
  }, [load]);

  React.useEffect(() => {
    if (changeTick === 0) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick]);

  // Opening a thread marks it read, like every mail client.
  React.useEffect(() => {
    if (!thread || !thread.unread) return;
    mailApi.threadAction(company.id, thread.id, "markRead").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.unread]);

  const base = `/c/${company.slug}/mail`;

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
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  const starred = thread.labelIds.includes("STARRED");
  const inInbox = thread.labelIds.includes("INBOX");
  const inTrash = thread.labelIds.includes("TRASH");
  const userLabels = labels.filter((l) => l.labelType === "user");
  const threadUserLabels = userLabels.filter((l) => thread.labelIds.includes(l.gmailLabelId));

  const act = async (action: ThreadActionName, opts?: { labelId?: string; labelName?: string }) => {
    try {
      await mailApi.threadAction(company.id, thread.id, action, opts);
      if (action === "trash") {
        toast("Moved to trash", "info");
        navigate(base);
        return;
      }
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const focusedDraftId = [...messages].reverse().find((message) => message.isDraft)?.id;

  return (
    <div className="flex min-h-full flex-col xl:h-full xl:min-h-0 xl:flex-row xl:overflow-hidden">
      <main className="min-w-0 flex-1 xl:overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
          {/* Header */}
          <div className="mb-1 flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              title="Back"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
              {thread.subject || "(no subject)"}
            </h1>
            <div className="flex shrink-0 items-center gap-0.5">
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
              <Button size="sm" variant="secondary" onClick={() => setHandOpen(true)}>
                <Bot size={14} className="mr-1.5" /> Hand to AI
              </Button>
            </div>
          </div>

          {/* Label chips */}
          {threadUserLabels.length > 0 && (
            <div className="mb-3 ml-9 flex flex-wrap gap-1.5">
              {threadUserLabels.map((l) => (
                <span
                  key={l.id}
                  className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-300"
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}

          {/* Handover timeline */}
          {handovers.length > 0 && (
            <div className="mb-3 space-y-2">
              {handovers.map((h) => (
                <HandoverCard key={h.id} handover={h} companyId={company.id} onChanged={load} />
              ))}
            </div>
          )}

          {/* Messages */}
          <div className="space-y-2">
            {messages.map((m) =>
              m.isDraft ? (
                <DraftCard key={m.id} draft={m} companyId={company.id} onChanged={load} />
              ) : (
                <MessageCard
                  key={m.id}
                  message={m}
                  companyId={company.id}
                  selfAddress={account.address}
                  expanded={expanded.has(m.id)}
                  onForward={() => forward(m)}
                  onToggle={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    })
                  }
                />
              ),
            )}
          </div>

          {/* Reply composer */}
          {!inTrash && messages.some((m) => !m.isDraft) && (
            <ReplyComposer
              companyId={company.id}
              accountId={account.id}
              thread={thread}
              onSent={load}
              onDraftSaved={load}
            />
          )}

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
      <aside className="min-h-[30rem] shrink-0 border-t border-slate-200 bg-white xl:min-h-0 xl:w-[23rem] xl:border-l xl:border-t-0 dark:border-slate-800 dark:bg-slate-950">
        <MailAssistant
          company={company}
          account={account}
          threadId={thread.id}
          focusedMessageId={focusedDraftId}
          openCompose={openCompose}
        />
      </aside>
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
      onClick={() => void onClick()}
      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      {children}
    </button>
  );
}

// ───────────────────────────── message card ─────────────────────────────

function forwardQuote(m: MailMessage): string {
  const lines = [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}`,
    `Date: ${m.sentAt ? new Date(m.sentAt).toLocaleString() : ""}`,
    `Subject: ${m.subject}`,
    `To: ${m.toEmails}`,
  ];
  if (m.attachments.length > 0) {
    lines.push(`Attachments (not re-attached): ${m.attachments.map((a) => a.filename).join(", ")}`);
  }
  lines.push("", m.bodyText || m.snippet);
  return lines.join("\n");
}

function MessageCard({
  message,
  companyId,
  selfAddress,
  expanded,
  onForward,
  onToggle,
}: {
  message: MailMessage;
  companyId: string;
  selfAddress: string;
  expanded: boolean;
  onForward: () => void;
  onToggle: () => void;
}) {
  const [showImages, setShowImages] = React.useState(false);
  const rendered = React.useMemo(
    () =>
      message.bodyHtml
        ? sanitizeEmailHtml(message.bodyHtml, showImages)
        : { html: "", hadRemoteImages: false },
    [message.bodyHtml, showImages],
  );
  const html = rendered.html;
  const hasRemoteImages = rendered.hadRemoteImages;
  const isSelf = message.fromEmail.toLowerCase() === selfAddress.toLowerCase();
  const fromLabel = isSelf ? "me" : message.fromName || message.fromEmail;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <button onClick={onToggle} className="flex w-full items-baseline gap-2 px-4 py-3 text-left">
        <span className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {fromLabel}
        </span>
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
            to {message.toEmails || "(unknown)"}
            {message.ccEmails ? `, cc ${message.ccEmails}` : ""}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{message.snippet}</span>
        )}
        <span className="shrink-0 text-xs tabular-nums text-slate-400">
          {shortMailDate(message.sentAt)}
        </span>
        <ChevronDown
          size={14}
          className={clsx(
            "shrink-0 text-slate-300 transition-transform dark:text-slate-600",
            expanded && "rotate-180",
          )}
        />
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
          {html ? (
            <div className="mail-html" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700 dark:text-slate-300">
              {message.bodyText || message.snippet}
            </pre>
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
          <div className="mt-3 flex justify-end">
            <button
              onClick={onForward}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
            >
              <Forward size={13} /> Forward
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ───────────────────────────── draft card ─────────────────────────────

function DraftCard({
  draft,
  companyId,
  onChanged,
}: {
  draft: MailMessage;
  companyId: string;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [editing, setEditing] = React.useState(false);
  const [to, setTo] = React.useState(draft.toEmails);
  const [subject, setSubject] = React.useState(draft.subject);
  const [body, setBody] = React.useState(draft.bodyText);
  const [busy, setBusy] = React.useState<"save" | "send" | "discard" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTo(draft.toEmails);
    setSubject(draft.subject);
    setBody(draft.bodyText);
  }, [draft.id, draft.toEmails, draft.subject, draft.bodyText]);

  const save = async (): Promise<string | null> => {
    // Returns the (possibly new) draft id — Gmail reissues ids on update.
    const res = await mailApi.updateDraft(companyId, draft.id, {
      to,
      subject,
      bodyText: body,
      cc: draft.ccEmails || undefined,
    });
    return res.message.id;
  };

  const dirty = to !== draft.toEmails || subject !== draft.subject || body !== draft.bodyText;

  const onSend = async () => {
    setBusy("send");
    setError(null);
    try {
      let id = draft.id;
      if (dirty) id = (await save()) ?? draft.id;
      await mailApi.sendDraft(companyId, id);
      toast("Sent", "success");
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          Draft
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400">
          to {draft.toEmails || "(no recipient yet)"}
        </span>
        {!editing && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={onSend}>
              {busy === "send" ? <Spinner size={13} /> : "Send"}
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
                setBusy("discard");
                try {
                  await mailApi.discardDraft(companyId, draft.id);
                  toast("Draft discarded", "info");
                  await onChanged();
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setBusy(null);
                }
              }}
            >
              Discard
            </Button>
          </>
        )}
      </div>
      {!editing ? (
        <div className="border-t border-amber-100 px-4 py-3 dark:border-amber-500/20">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-slate-700 dark:text-slate-300">
            {draft.bodyText || draft.snippet}
          </pre>
        </div>
      ) : (
        <div className="space-y-3 border-t border-amber-100 px-4 py-3 dark:border-amber-500/20">
          <Input label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea
            label="Message"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <FormError message={error} />
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || !dirty}
              onClick={async () => {
                setBusy("save");
                setError(null);
                try {
                  await save();
                  toast("Draft saved", "success");
                  setEditing(false);
                  await onChanged();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "save" ? <Spinner size={13} /> : "Save"}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={onSend}>
              {busy === "send" ? <Spinner size={13} /> : "Send"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── reply composer ─────────────────────────────

function ReplyComposer({
  companyId,
  accountId,
  thread,
  onSent,
  onDraftSaved,
}: {
  companyId: string;
  accountId: string;
  thread: MailThread;
  onSent: () => Promise<void>;
  onDraftSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [replyAll, setReplyAll] = React.useState(false);
  const [recipients, setRecipients] = React.useState<{ to: string; cc: string } | null>(null);
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState<"send" | "draft" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const attach = useMailAttachments(companyId, accountId);

  React.useEffect(() => {
    if (!open || recipients) return;
    mailApi
      .replyRecipients(companyId, thread.id)
      .then(setRecipients)
      .catch(() => setRecipients({ to: "", cc: "" }));
  }, [open, recipients, companyId, thread.id]);

  if (!open) {
    return (
      <div className="mt-3 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setReplyAll(false);
            setOpen(true);
          }}
        >
          <Reply size={14} className="mr-1.5" /> Reply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setReplyAll(true);
            setOpen(true);
          }}
        >
          <ReplyAll size={14} className="mr-1.5" /> Reply all
        </Button>
      </div>
    );
  }

  const submit = async (kind: "send" | "draft") => {
    setBusy(kind);
    setError(null);
    try {
      const input = {
        to: recipients?.to ?? "",
        cc: replyAll ? recipients?.cc || undefined : undefined,
        bodyText: body,
        threadId: thread.id,
        attachmentIds: attach.ids.length ? attach.ids : undefined,
      };
      if (kind === "send") {
        await mailApi.send(companyId, accountId, input);
        toast("Sent", "success");
        setBody("");
        attach.clear();
        setOpen(false);
        await onSent();
      } else {
        await mailApi.createDraft(companyId, accountId, input);
        toast("Draft saved", "success");
        setBody("");
        attach.clear();
        setOpen(false);
        await onDraftSaved();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {replyAll ? <ReplyAll size={13} /> : <Reply size={13} />}
        {recipients === null ? (
          <Spinner size={12} />
        ) : (
          <span className="min-w-0 flex-1 truncate">
            to {recipients.to || "(unknown)"}
            {replyAll && recipients.cc ? `, cc ${recipients.cc}` : ""}
          </span>
        )}
        <button
          className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          onClick={() => setReplyAll((v) => !v)}
        >
          {replyAll ? "Reply only to sender" : "Reply all"}
        </button>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Write your reply…"
        autoFocus
      />
      <div className="mt-2">
        <AttachmentBar
          items={attach.items}
          uploading={attach.uploading}
          onAdd={attach.addFiles}
          onRemove={attach.remove}
        />
      </div>
      <FormError message={error} className="mt-2" />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null || attach.uploading || !body.trim()}
          onClick={() => submit("draft")}
        >
          {busy === "draft" ? <Spinner size={13} /> : "Save draft"}
        </Button>
        <Button
          size="sm"
          disabled={busy !== null || attach.uploading || !body.trim()}
          onClick={() => submit("send")}
        >
          {busy === "send" ? <Spinner size={13} /> : "Send"}
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────── handovers ─────────────────────────────

function HandoverCard({
  handover,
  companyId,
  onChanged,
}: {
  handover: MailHandover;
  companyId: string;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [showResult, setShowResult] = React.useState(false);
  const statusStyle: Record<MailHandover["status"], string> = {
    pending: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    running: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
    completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-2 text-sm">
        <Bot size={14} className="shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
          <span className="font-medium">{handover.employee?.name ?? "AI employee"}</span>
          {" · "}
          {handover.mode === "draft"
            ? "drafting a reply"
            : handover.mode === "reply"
              ? "replying"
              : "triaging"}
          {handover.sourceKind === "rule" && <span className="text-slate-400"> · via rule</span>}
        </span>
        <span
          className={clsx(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            statusStyle[handover.status],
          )}
        >
          {handover.status === "running" && <Spinner size={9} />} {handover.status}
        </span>
        {handover.status === "failed" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await mailApi.retryHandover(companyId, handover.id);
                toast("Retrying", "info");
                await onChanged();
              } catch (err) {
                toast((err as Error).message, "error");
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
  const { toast } = useToast();
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
        setEmployeeId(res.direct[0]?.employeeId ?? "");
      })
      .catch((err) => setError((err as Error).message));
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
      toast("Handed to AI — you'll be notified when it finishes", "success");
      onClose();
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
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
                  (m === "reply" && !canSend) || ((m === "draft" || m === "triage") && !canDraft);
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
            <Button onClick={submit} disabled={busy || !employeeId || !canDraft}>
              {busy ? <Spinner size={14} /> : "Hand over"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
