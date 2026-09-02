import React from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Bot, MessagesSquare, MoreHorizontal, Paperclip, Smile, Trash2 } from "lucide-react";

import { EmojiPicker } from "@/components/workspace/EmojiPicker";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { errorMessage } from "@/lib/errors";
import type {
  Mentionable,
  WorkspaceAttachment,
  WorkspaceAuthor,
  WorkspaceMessage,
} from "@/lib/workspace";

/**
 * How a workspace message looks, wherever it is being read.
 *
 * This started out inside `pages/Workspace.tsx` and moved here the moment a
 * second surface needed it: Home shows an unread channel in place rather than
 * sending you to the Workspace to read it. Two renderers for one message would
 * have drifted within a release — one of them would learn about a new
 * attachment kind, or stop rendering mentions as pills, and nobody would
 * notice until the quieter surface looked wrong.
 *
 * The four mutation props are optional as a set. A surface that only reads
 * passes none of them and loses the hover toolbar, the edit affordance and the
 * clickable reactions along with them; the reactions themselves still render,
 * because who reacted is part of reading the message.
 *
 * The list *arithmetic* — merging pages, folding in a socket frame — lives in
 * `lib/workspaceMessages.ts` instead, where it can be unit-tested without a DOM.
 */

// ────────────────────────── Message list ────────────────────────────────

export function MessageList({
  messages,
  meId,
  mentionables,
  onAttachmentUrl,
  unreadFromMessageId = null,
  editingMessageId = null,
  onSetEditing,
  onEdit,
  onDelete,
  onReact,
}: {
  messages: WorkspaceMessage[];
  meId: string;
  mentionables: Mentionable[];
  onAttachmentUrl: (id: string) => string;
  /**
   * Draw the "new messages" line above this message. Comes from
   * `firstUnreadMessageId` in `lib/unreadMessages.ts`, which applies the same
   * rule the server counts the badge by. Null draws no line.
   */
  unreadFromMessageId?: string | null;
  editingMessageId?: string | null;
  /**
   * The four mutations are optional together: a surface that only reads —
   * the unread peek on Home — omits them and the hover toolbar, the edit
   * affordance and the reaction buttons go with them, rather than that
   * surface having to supply four handlers it has no use for.
   */
  onSetEditing?: (id: string | null) => void;
  onEdit?: (m: WorkspaceMessage, content: string) => Promise<void>;
  onDelete?: (m: WorkspaceMessage) => Promise<void>;
  onReact?: (m: WorkspaceMessage, emoji: string) => Promise<void>;
}) {
  // Group adjacent messages by author within 5-minute windows for a cleaner
  // Slack-like layout: first message renders full (avatar + name + ts),
  // subsequent ones indent and hide the header.
  let prev: WorkspaceMessage | null = null;
  return (
    <div className="space-y-0.5">
      {messages.map((m) => {
        const bundled = isBundled(prev, m) && m.id !== unreadFromMessageId;
        prev = m;
        return (
          <React.Fragment key={m.id}>
            {m.id === unreadFromMessageId && <NewMessagesDivider />}
            <MessageRow
              message={m}
              bundled={bundled}
              meId={meId}
              mentionables={mentionables}
              onAttachmentUrl={onAttachmentUrl}
              editing={editingMessageId === m.id}
              onSetEditing={onSetEditing}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * The line between what you have read and what you have not. Deliberately the
 * one loud thing in an otherwise quiet list — it is the answer to "where was
 * I", and a subtle version of it is a line nobody finds.
 *
 * A heading rather than a `role="separator"`: separator is on ARIA's
 * children-presentational list, which strips the word "New" out of the
 * accessibility tree and leaves a nameless rule that no quick-nav key can
 * reach. As a heading it is both announced and jumpable. `data-unread-divider`
 * is how a surface scrolls you to it instead of to the newest message.
 */
function NewMessagesDivider() {
  return (
    <div data-unread-divider="" className="flex items-center gap-2 pt-3">
      <span aria-hidden="true" className="h-px flex-1 bg-rose-400 dark:bg-rose-500/60" />
      <h3 className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
        New<span className="sr-only"> messages below</span>
      </h3>
      <span aria-hidden="true" className="h-px w-6 bg-rose-400 dark:bg-rose-500/60" />
    </div>
  );
}

export function isBundled(prev: WorkspaceMessage | null, m: WorkspaceMessage): boolean {
  if (!prev) return false;
  if (prev.authorKind !== m.authorKind) return false;
  const pa = authorId(prev.author);
  const ma = authorId(m.author);
  if (!pa || !ma || pa !== ma) return false;
  const gap = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return gap < 5 * 60 * 1000;
}

function authorId(a: WorkspaceAuthor | null): string | null {
  if (!a) return null;
  // A system author carries no id, so its *name* is its identity. Collapsing
  // them all to "system" bundled a channel's incoming webhooks together — the
  // release bot's post landed silently under the metrics bot's name.
  if (a.kind === "system") return `system:${a.name}`;
  return a.id;
}

function MessageRow({
  message,
  bundled,
  meId,
  mentionables,
  onAttachmentUrl,
  editing,
  onSetEditing,
  onEdit,
  onDelete,
  onReact,
}: {
  message: WorkspaceMessage;
  bundled: boolean;
  meId: string;
  mentionables: Mentionable[];
  onAttachmentUrl: (id: string) => string;
  editing: boolean;
  onSetEditing?: (id: string | null) => void;
  onEdit?: (m: WorkspaceMessage, content: string) => Promise<void>;
  onDelete?: (m: WorkspaceMessage) => Promise<void>;
  onReact?: (m: WorkspaceMessage, emoji: string) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState(message.content);
  const [editError, setEditError] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const dialog = useDialog();

  // When edit mode is entered (often via ↑ from the composer), refresh the
  // draft from the latest message content and bring the row into view.
  React.useEffect(() => {
    if (editing) {
      setDraft(message.content);
      setEditError(null);
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const isMine =
    message.author?.kind === "user" && "id" in message.author && message.author.id === meId;
  const isDeleted = !!message.deletedAt;
  const ts = new Date(message.createdAt);
  const timeLabel = ts.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const dateLabel = ts.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      ref={rowRef}
      className={
        "group relative flex gap-3 rounded-md px-2 py-1 " +
        (bundled ? "" : "mt-3 ") +
        "hover:bg-slate-50 dark:hover:bg-slate-800/60"
      }
    >
      <div className="w-10 shrink-0">
        {!bundled ? (
          <ChatAuthorAvatar author={message.author} />
        ) : (
          <div className="mt-1 hidden h-4 w-full text-right text-[10px] text-slate-400 group-hover:block dark:text-slate-500">
            {timeLabel}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!bundled && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {message.author?.name ?? "(unknown)"}
            </span>
            {message.author?.kind === "ai" && (
              <span className="rounded bg-indigo-50 px-1 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                AI
              </span>
            )}
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              {dateLabel} · {timeLabel}
            </span>
            {message.editedAt && (
              <span className="text-[11px] text-slate-400 dark:text-slate-500">(edited)</span>
            )}
          </div>
        )}

        {editing ? (
          <div className="mt-1 flex items-center gap-2">
            <textarea
              className="min-h-[36px] w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(message.content);
                  onSetEditing?.(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  setEditError(null);
                  try {
                    await onEdit?.(message, draft);
                    onSetEditing?.(null);
                  } catch (err) {
                    setEditError(errorMessage(err));
                  }
                }
              }}
              autoFocus
            />
            <Button
              size="sm"
              onClick={async () => {
                setEditError(null);
                try {
                  await onEdit?.(message, draft);
                  onSetEditing?.(null);
                } catch (e) {
                  setEditError(errorMessage(e));
                }
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(message.content);
                onSetEditing?.(null);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : isDeleted ? (
          <div className="mt-0.5 text-sm italic text-slate-400 dark:text-slate-500">
            This message was deleted.
          </div>
        ) : (
          <MessageBody content={message.content} mentionables={mentionables} />
        )}

        {editing && <FormError message={editError} className="mt-1.5" />}

        {!isDeleted && message.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <AttachmentPreview key={a.id} attachment={a} url={onAttachmentUrl(a.id)} />
            ))}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => {
              const face = (
                <>
                  <span>{r.emoji}</span>
                  <span className="tabular-nums">{r.count}</span>
                </>
              );
              const tone = r.byMe
                ? "border border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-200"
                : "border border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
              const title = r.actors.map((a) => a.name).join(", ");
              // A read-only surface still shows who reacted; it just cannot
              // add one, so the pill is not a button pretending otherwise.
              return onReact ? (
                <button
                  key={r.emoji}
                  onClick={() => onReact(message, r.emoji)}
                  title={title}
                  className={
                    "flex h-6 items-center gap-1 rounded-full px-2 text-xs hover:brightness-95 " +
                    tone
                  }
                >
                  {face}
                </button>
              ) : (
                <span
                  key={r.emoji}
                  title={title}
                  className={"flex h-6 items-center gap-1 rounded-full px-2 text-xs " + tone}
                >
                  {face}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {!editing && !isDeleted && (onReact || (isMine && onEdit)) && (
        <div className="absolute right-2 top-1 hidden items-center gap-1 rounded-md border border-slate-200 bg-white shadow-sm group-hover:flex dark:border-slate-700 dark:bg-slate-900">
          {onReact && (
            <div className="relative">
              <button
                onClick={() => setEmojiOpen((o) => !o)}
                className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
                title="Add reaction"
              >
                <Smile size={14} />
              </button>
              {emojiOpen && (
                <EmojiPicker
                  onPick={(e) => onReact(message, e)}
                  onClose={() => setEmojiOpen(false)}
                />
              )}
            </div>
          )}
          {isMine && onEdit && (
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
              title="More"
            >
              <MoreHorizontal size={14} />
            </button>
          )}
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-30 mt-1 w-32 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <button
                  onClick={() => {
                    onSetEditing?.(message.id);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Edit
                </button>
                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    const ok = await dialog.confirm({
                      title: "Delete message?",
                      message: "This can't be undone.",
                      confirmLabel: "Delete",
                      variant: "danger",
                    });
                    if (!ok) return;
                    try {
                      await onDelete?.(message);
                    } catch (e) {
                      void dialog.error(e, { title: "Couldn’t delete the message" });
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatAuthorAvatar({ author }: { author: WorkspaceAuthor | null }) {
  if (!author) return <div className="h-9 w-9 rounded-md bg-slate-200 dark:bg-slate-700" />;
  if (author.kind === "ai") {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
        <Bot size={18} />
      </div>
    );
  }
  if (author.kind === "system")
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
        <MessagesSquare size={16} />
      </div>
    );
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-100 text-sm font-semibold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
      {initials(author.name)}
    </div>
  );
}

export function initials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MessageBody({
  content,
  mentionables,
}: {
  content: string;
  mentionables: Mentionable[];
}) {
  // Full GitHub-flavored markdown (bold, lists, code fences, tables, links)
  // via marked + DOMPurify — same pipeline as the 1:1 EmployeeChat. We
  // post-process the sanitized HTML to wrap `@handle` and `#base/foo`
  // tokens in clickable pills backed by the mentionables directory. The
  // walker skips inside <code>/<pre>/<a> so code samples and already-linked
  // text aren't corrupted.
  const html = React.useMemo(() => {
    const raw = marked.parse(content ?? "", {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    const safe = DOMPurify.sanitize(raw);
    return linkifyMentions(safe, mentionables);
  }, [content, mentionables]);

  return (
    <div
      className="chat-md mt-0.5 break-words text-sm text-slate-700 dark:text-slate-200"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleMentionClickCapture}
    />
  );
}

/**
 * Intercept clicks on mention pills: we render them as anchors with
 * `data-mention-href` so React Router's link click interception still
 * delegates through the normal page-level handler. Using an anchor + href
 * keeps middle-click / cmd-click working too (opens in a new tab).
 */
function handleMentionClickCapture(_e: React.MouseEvent<HTMLDivElement>): void {
  // The anchors already have the right href — no extra JS needed here. The
  // handler is kept as a hook point for a future "jump to channel" action
  // that we might want to intercept without a full page nav.
}

const MENTION_RE = /(^|[\s(])([@#][a-z0-9][a-z0-9/_-]{0,80}[a-z0-9])/gi;

function linkifyMentions(html: string, mentionables: Mentionable[]): string {
  if (typeof document === "undefined") return html;
  // "First wins" — listCompanyMentionables emits users first, then AI, so a
  // human handle is preferred over a colliding AI slug when both exist in
  // the directory (the server's handle guard normally prevents this, but
  // older data can still collide).
  const byHandle = new Map<string, Mentionable>();
  for (const m of mentionables) {
    const k = m.handle.toLowerCase();
    if (!byHandle.has(k)) byHandle.set(k, m);
  }
  const container = document.createElement("div");
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const skip = new Set(["CODE", "PRE", "A"]);
  const nodes: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    let p: Node | null = node.parentNode;
    let safeToWrap = true;
    while (p && p !== container) {
      if (p instanceof HTMLElement && skip.has(p.tagName)) {
        safeToWrap = false;
        break;
      }
      p = p.parentNode;
    }
    if (safeToWrap) nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const t of nodes) {
    const text = t.nodeValue ?? "";
    if (!/[@#]/.test(text)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text))) {
      const start = m.index + m[1].length;
      if (start > last) {
        frag.appendChild(document.createTextNode(text.slice(last, start)));
      }
      const token = m[2];
      const hit = byHandle.get(token.toLowerCase());
      if (hit) {
        const a = document.createElement("a");
        a.href = hit.href;
        a.className = mentionPillClass(hit.kind);
        a.title = hit.label + (hit.sublabel ? ` · ${hit.sublabel}` : "");
        a.textContent = token;
        frag.appendChild(a);
      } else {
        // Unresolved — render as a greyed pill so the author notices the
        // typo instead of it silently looking like normal text.
        const span = document.createElement("span");
        span.className =
          "rounded bg-slate-100 px-1 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
        span.textContent = token;
        frag.appendChild(span);
      }
      last = start + token.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    if (frag.childNodes.length > 0) t.parentNode?.replaceChild(frag, t);
  }
  return container.innerHTML;
}

function mentionPillClass(kind: Mentionable["kind"]): string {
  const core = "rounded px-1 no-underline hover:underline ";
  switch (kind) {
    case "user":
      return core + "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300";
    case "ai":
      return core + "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300";
    case "channel":
      return core + "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300";
    case "base":
    case "base_table":
      return core + "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
    case "connection":
      return core + "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300";
  }
}

export function AttachmentPreview({
  attachment,
  url,
}: {
  attachment: WorkspaceAttachment;
  url: string;
}) {
  if (attachment.isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={attachment.filename}
          className="max-h-64 max-w-xs rounded-lg border border-slate-200 object-cover dark:border-slate-700"
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Paperclip size={12} />
      <span className="max-w-[240px] truncate">{attachment.filename}</span>
      <span className="text-slate-400 dark:text-slate-500">
        {formatBytes(attachment.sizeBytes)}
      </span>
    </a>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
