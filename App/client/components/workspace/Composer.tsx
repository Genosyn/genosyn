import React from "react";
import { Bot, Hash, Paperclip, Send, Smile, User as UserIcon, X } from "lucide-react";

import { EmojiPicker } from "@/components/workspace/EmojiPicker";
import { formatBytes } from "@/components/workspace/MessageList";
import {
  ChatResourceReference,
  insertResourceReference,
  ResourceReferencePicker,
  resourceQueryAtCaret,
  useResourceReferences,
} from "@/components/chat/ResourceReferencePicker";
import { Avatar as UIAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useComposerFileDrop } from "@/lib/fileDrop";
import { Mentionable, WorkspaceAttachment, WorkspaceMessage, workspaceApi } from "@/lib/workspace";

/**
 * The box you write a channel message in.
 *
 * This lived inside `pages/Workspace.tsx` until a second surface needed it —
 * the unread peek on Home, whose placeholder had been telling people to
 * "@mention an AI employee" above a plain `<textarea>` that had no idea what
 * an @ was. Rather than grow a second, lesser composer (the exact drift
 * `MessageList` was promoted here to prevent), the real one moved out.
 *
 * What it carries: @ mentions of people and AI employees, # references to
 * channels and product resources, attachments by button, drag, or paste,
 * emoji, Enter-to-send, and a 240px-capped auto-grow.
 *
 * Two things are optional as a set rather than always on, because they only
 * make sense where the surrounding surface can honour them:
 *
 *  - `editLast` wires ↑-on-an-empty-draft to "edit my last message". A
 *    read-only transcript has no editor to open, so it must not be offered one.
 *  - `onSent` hands the saved message back for a surface that owns its own
 *    list. The Workspace page deliberately omits it and appends from the
 *    socket echo instead, which is where its unread accounting lives.
 */

/** The little a composer needs to know about the room it is posting into. */
export type ComposerChannel = {
  id: string;
  /** `"dm"` unlocks `/new`. Typed loosely because `HomeChannel.kind` is a string. */
  kind: string;
  /** Names the room in the placeholder — `#youtube`, or a person for a DM. */
  label: string;
};

/**
 * For a host that has to answer for a key before the composer sees it — a
 * modal, whose Escape handler runs on `window` in the capture phase and so
 * beats every React listener inside it.
 */
export type ChannelComposerHandle = {
  /** Close the topmost open popup. True when one actually was open. */
  dismissPopup: () => boolean;
  /** Whether there is unsent work in here worth warning about. */
  hasDraft: () => boolean;
  focus: () => void;
};

export const ChannelComposer = React.forwardRef<
  ChannelComposerHandle,
  {
    company: Company;
    channel: ComposerChannel;
    mentionables: Mentionable[];
    /** The saved message, for a surface that keeps its own list. */
    onSent?: (message: WorkspaceMessage) => void;
    /** ↑ on an empty draft edits your last message. All three or none. */
    editLast?: {
      messages: WorkspaceMessage[];
      meId: string;
      onEdit: (messageId: string) => void;
    };
    /** Chrome for the tray, so each surface can seat it in its own layout. */
    className?: string;
  }
>(function ChannelComposer({ company, channel, mentionables, onSent, editLast, className }, ref) {
  const [draft, setDraft] = React.useState("");
  const [attachments, setAttachments] = React.useState<WorkspaceAttachment[]>([]);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [resourceQuery, setResourceQuery] = React.useState<string | null>(null);
  const [resourceStart, setResourceStart] = React.useState<number | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const { references, loading: referencesLoading } = useResourceReferences(
    company.id,
    resourceQuery,
  );

  // Autocomplete fires as soon as the caret sits right after `@` or `#`.
  // `mentionPrefix` carries the trigger char so the matcher can stay
  // simple — `@` hits users+AI, `#` hits channels/bases/tables/connections.
  const [mentionPrefix, setMentionPrefix] = React.useState<"@" | "#" | null>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      // Peeled in the order they stack, so one Escape closes one thing.
      dismissPopup: () => {
        if (resourceQuery !== null) {
          setResourceQuery(null);
          setResourceStart(null);
          return true;
        }
        if (mentionOpen) {
          setMentionOpen(false);
          setMentionPrefix(null);
          return true;
        }
        if (emojiOpen) {
          setEmojiOpen(false);
          return true;
        }
        return false;
      },
      hasDraft: () => draft.trim() !== "" || attachments.length > 0,
      focus: () => textRef.current?.focus(),
    }),
    [resourceQuery, mentionOpen, emojiOpen, draft, attachments.length],
  );

  // Reset the draft when the active channel changes — prevents leaking a
  // half-written message into the next room. Keyed on the id string, never on
  // the object: callers pass an inline literal whose identity changes every
  // render.
  React.useEffect(() => {
    setDraft("");
    setAttachments([]);
    setError(null);
    setResourceQuery(null);
    setResourceStart(null);
  }, [channel.id]);

  // Drive the textarea height from the rendered value rather than from the
  // input/keydown handler. Reading scrollHeight inside an event handler
  // sees the pre-render DOM, so clearing the draft on Enter would leave
  // the textarea pinned to the multi-line height it grew to while typing
  // — which then squeezed out the message list and made new sends look
  // like they hadn't scrolled.
  React.useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // "auto" lets the textarea fall back to its natural single-row height
    // so scrollHeight reads the content's actual height. Setting it to
    // "0px" makes scrollHeight return whatever space the flex parent
    // offered up — which is huge — and the cap below pins it to 240px.
    el.style.height = "auto";
    el.style.height = `${Math.min(240, el.scrollHeight)}px`;
  }, [draft]);

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      if (channel.kind === "dm" && trimmed === "/new" && attachments.length === 0) {
        await workspaceApi.resetContext(company.id, channel.id);
        setDraft("");
        setMentionOpen(false);
        setResourceQuery(null);
        return;
      }
      const sent = await workspaceApi.sendMessage(company.id, channel.id, {
        content: trimmed,
        attachmentIds: attachments.map((a) => a.id),
      });
      // Only what was actually posted is cleared. Anything typed during the
      // round trip is the next message, not part of this one.
      setDraft((current) => (current === draft ? "" : current));
      setAttachments([]);
      setEmojiOpen(false);
      setMentionOpen(false);
      onSent?.(sent);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
      // Clicking Send disables the button under the pointer, which drops
      // focus to <body> and restarts the next Tab at the top of the page.
      textRef.current?.focus();
    }
  }

  async function onFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    setError(null);
    for (const f of Array.from(files)) {
      try {
        const a = await workspaceApi.uploadAttachment(company.id, f);
        setAttachments((prev) => [...prev, a]);
      } catch (err) {
        setError(`Upload failed: ${errorMessage(err)}`);
      }
    }
  }

  // Paste a screenshot or drag a file onto the composer — routes straight to
  // the same upload path as the paperclip button.
  const { dragActive, onPaste, dragProps } = useComposerFileDrop((files) => {
    void onFiles(files);
  });

  function updateDraft(next: string) {
    setDraft(next);
    // Height is reapplied by the useEffect on `draft` after React renders.
    const el = textRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? next.length;
    const head = next.slice(0, caret);
    const m = head.match(/([@#])([a-z0-9/_-]*)$/i);
    const resource = resourceQueryAtCaret(next, caret);
    if (m) {
      setMentionOpen(true);
      setMentionPrefix(m[1] as "@" | "#");
      setMentionQuery(m[2].toLowerCase());
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
      setMentionPrefix(null);
    }
    setResourceQuery(resource?.query ?? null);
    setResourceStart(resource?.start ?? null);
  }

  function insertMention(handle: string) {
    const el = textRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const head = draft.slice(0, caret);
    const tail = draft.slice(caret);
    const replaced = head.replace(/[@#][a-z0-9/_-]*$/i, `${handle} `);
    setDraft(replaced + tail);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      const pos = replaced.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function insertReference(reference: ChatResourceReference) {
    const el = textRef.current;
    if (!el || resourceStart === null) return;
    const caret = el.selectionStart ?? draft.length;
    const inserted = insertResourceReference({
      value: draft,
      caret,
      start: resourceStart,
      companySlug: company.slug,
      reference,
    });
    setDraft(inserted.value);
    setMentionOpen(false);
    setResourceQuery(null);
    setResourceStart(null);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
    });
  }

  const mentionCandidates = React.useMemo(() => {
    if (!mentionPrefix) return [] as Mentionable[];
    const kinds =
      mentionPrefix === "@"
        ? new Set(["user", "ai"])
        : new Set(["channel", "base", "base_table", "connection"]);
    return mentionables
      .filter((x) => kinds.has(x.kind))
      .filter((x) => {
        if (!mentionQuery) return true;
        const q = mentionQuery;
        return x.handle.toLowerCase().includes(q) || x.label.toLowerCase().includes(q);
      })
      .slice(0, 30);
  }, [mentionables, mentionPrefix, mentionQuery]);

  // Clamp the highlighted index back into range whenever the candidate list
  // shrinks (e.g. the user keeps typing and narrows the matches).
  React.useEffect(() => {
    setMentionIndex((i) => {
      const length = references.length || mentionCandidates.length;
      if (length === 0) return 0;
      if (i >= length) return length - 1;
      if (i < 0) return 0;
      return i;
    });
  }, [mentionCandidates.length, references.length]);

  return (
    <div className={className}>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <Paperclip size={12} className="text-slate-400" />
              <span className="max-w-[180px] truncate">{a.filename}</span>
              <span className="text-slate-400">{formatBytes(a.sizeBytes)}</span>
              <button
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                aria-label={`Remove ${a.filename}`}
                className="ml-1 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <FormError message={error} className="mb-2" />
      <div
        {...dragProps}
        className={
          "relative flex items-start gap-2 rounded-xl border bg-white p-2 dark:bg-slate-900 " +
          (dragActive
            ? "border-indigo-500 ring-2 ring-indigo-500/30 "
            : "border-slate-200 focus-within:border-indigo-400 dark:border-slate-700")
        }
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-indigo-50/90 text-sm font-medium text-indigo-700 dark:bg-indigo-950/80 dark:text-indigo-200">
            <Paperclip size={14} className="mr-1.5" /> Drop to attach
          </div>
        )}
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          multiple
          onChange={(e) => onFiles(e.target.files)}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Attach file"
          aria-label="Attach file"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          ref={textRef}
          value={draft}
          onChange={(e) => updateDraft(e.target.value)}
          onPaste={onPaste}
          aria-label={`Message ${channel.label}`}
          onKeyDown={(e) => {
            // Mid-composition keys belong to the IME, not to us: Enter is how
            // a Japanese, Chinese or Korean writer accepts a candidate.
            if (e.nativeEvent.isComposing) return;
            if (resourceQuery !== null && references.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % references.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + references.length) % references.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertReference(references[mentionIndex] ?? references[0]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setResourceQuery(null);
                return;
              }
            }
            if (mentionOpen && mentionCandidates.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionCandidates.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex(
                  (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const pick = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
                if (pick) insertMention(pick.handle);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionOpen(false);
                return;
              }
            }
            // Slack/iMessage convention: ↑ on an empty composer pulls up the
            // most recent message you sent in this channel for editing.
            if (
              editLast &&
              e.key === "ArrowUp" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              draft === "" &&
              attachments.length === 0
            ) {
              const lastOwn = findLastOwnMessage(editLast.messages, editLast.meId);
              if (lastOwn) {
                e.preventDefault();
                editLast.onEdit(lastOwn.id);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            } else if (e.key === "Escape") {
              setMentionOpen(false);
              setEmojiOpen(false);
            }
          }}
          placeholder={`Message ${channel.label}`}
          className="min-h-[28px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
          rows={1}
        />
        <div className="relative">
          <button
            onClick={() => setEmojiOpen((o) => !o)}
            className="mt-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Emoji"
            aria-label="Emoji"
          >
            <Smile size={16} />
          </button>
          {emojiOpen && (
            <EmojiPicker
              onPick={(e) => setDraft((d) => d + e)}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>
        <Button size="sm" disabled={sending} onClick={handleSend}>
          {sending ? <Spinner size={12} /> : <Send size={14} />}
          Send
        </Button>

        {mentionOpen &&
          mentionCandidates.length > 0 &&
          (mentionPrefix === "@" || (!referencesLoading && references.length === 0)) && (
            <div className="absolute bottom-full left-12 z-20 mb-2 w-80 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {mentionPrefix === "@" ? "People" : "Resources"}
              </div>
              <div className="max-h-72 overflow-y-auto pb-1">
                {mentionCandidates.map((x, i) => (
                  <button
                    key={`${x.kind}-${x.handle}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      insertMention(x.handle);
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={
                      "flex w-full items-center gap-2.5 px-3 py-1.5 text-left " +
                      (i === mentionIndex
                        ? "bg-slate-100 dark:bg-slate-800"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800")
                    }
                  >
                    {x.kind === "user" || x.kind === "ai" ? (
                      <UIAvatar
                        name={x.label}
                        src={x.avatarUrl ?? null}
                        kind={x.kind === "ai" ? "ai" : "human"}
                        size="sm"
                      />
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800">
                        <MentionIcon kind={x.kind} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                          {x.label}
                        </span>
                        {x.kind === "ai" && (
                          <span className="shrink-0 rounded bg-indigo-50 px-1 text-[10px] font-medium uppercase tracking-wide text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                            AI
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-mono">{x.handle}</span>
                        {x.sublabel ? ` · ${x.sublabel}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        {resourceQuery !== null && (referencesLoading || references.length > 0) && (
          <ResourceReferencePicker
            references={references}
            loading={referencesLoading}
            activeIndex={mentionIndex}
            onHover={setMentionIndex}
            onPick={insertReference}
            className="absolute bottom-full left-12 z-20 mb-2 w-80"
          />
        )}
      </div>
      <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        Press{" "}
        <kbd className="rounded border border-slate-200 px-1 dark:border-slate-700">Enter</kbd> to
        send ·{" "}
        <kbd className="rounded border border-slate-200 px-1 dark:border-slate-700">
          Shift+Enter
        </kbd>{" "}
        newline
        {editLast ? (
          <>
            {" "}
            · <kbd className="rounded border border-slate-200 px-1 dark:border-slate-700">
              ↑
            </kbd>{" "}
            edit last
          </>
        ) : null}{" "}
        · <span className="font-mono">@</span> for people · <span className="font-mono">#</span> for
        product areas &amp; resources
        {channel.kind === "dm" ? (
          <>
            {" "}
            · <span className="font-mono">/new</span> for new context
          </>
        ) : null}
      </div>
    </div>
  );
});

/** The newest message you wrote here that still exists — what ↑ opens. */
export function findLastOwnMessage(
  messages: WorkspaceMessage[],
  meId: string,
): WorkspaceMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.deletedAt) continue;
    const a = m.author;
    if (a && a.kind === "user" && "id" in a && a.id === meId) return m;
  }
  return null;
}

function MentionIcon({ kind }: { kind: Mentionable["kind"] }) {
  const cls = "shrink-0";
  switch (kind) {
    case "user":
      return <UserIcon size={14} className={cls + " text-emerald-500"} />;
    case "ai":
      return <Bot size={14} className={cls + " text-indigo-500"} />;
    case "channel":
      return <Hash size={14} className={cls + " text-sky-500"} />;
    case "base":
    case "base_table":
      return <Hash size={14} className={cls + " text-amber-500"} />;
    case "connection":
      return <Hash size={14} className={cls + " text-violet-500"} />;
  }
}
