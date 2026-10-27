import React from "react";
import {
  CalendarPlus,
  ChevronDown,
  Forward,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { type MailAttachment, type MailMessage, type MailThread, mailApi } from "@/lib/mail";
import {
  forwardBlock,
  forwardSubject,
  quotedReply,
  replyBody,
  replyDraftKey,
  REPLY_DRAFT_TTL_MS,
  replyRecipientsFor,
  replySubject,
} from "@/lib/mailCompose";
import {
  emptyMailRecipients,
  mailHeaders,
  mailRecipientProblem,
  mailRecipientsFrom,
  type MailRecipients,
  mailRecipientsSummary,
  threadParticipants,
} from "@/lib/mailRecipients";
import { errorMessage } from "@/lib/errors";
import { useComposerFileDrop } from "@/lib/fileDrop";
import {
  MailRecipientFields,
  type MailRecipientFieldsHandle,
  useMailRecipientCheck,
} from "@/components/mail/MailRecipientFields";
import { AttachmentBar, useMailAttachments } from "@/components/MailAttachments";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";

/**
 * The reply box under a thread — Reply, Reply all and Forward in one place.
 *
 * Recipients open as chips with names (`replyRecipientsFor`), and every line
 * is editable: take someone off, add someone, move them to Cc or Bcc. A reply
 * carries the message it answers as a quote, folded behind "•••" the way mail
 * clients show it; a forward carries the original's attachments, each one
 * removable. ⌘↵ sends.
 *
 * What the Member writes is kept in this browser until it is sent, saved as a
 * draft or discarded, so leaving the thread never loses a half-written reply
 * (`replyDraftKey`). Scheduling a call from here puts the invitation's details
 * straight into the reply.
 */

export type ReplyMode = "reply" | "replyAll" | "forward";

export type ReplyComposerHandle = {
  /** Open on a mode; `message` answers that message instead of the newest one. */
  open: (mode: ReplyMode, message?: MailMessage) => void;
  /** Put text in the reply, opening it on Reply all when it is closed. */
  insertText: (text: string) => void;
};

type SavedReply = {
  mode: ReplyMode;
  sourceId: string;
  headers: { to: string; cc: string; bcc: string };
  subject: string;
  body: string;
  includeQuote: boolean;
  forwardIndexes: number[];
  savedAt: number;
};

type ComposerState = {
  mode: ReplyMode;
  source: MailMessage;
  fields: MailRecipients;
  subject: string;
  body: string;
  quote: string | null;
  includeQuote: boolean;
  forwardKept: number[];
};

function readSaved(key: string): SavedReply | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedReply;
    if (
      !saved ||
      typeof saved.body !== "string" ||
      Date.now() - saved.savedAt > REPLY_DRAFT_TTL_MS
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

function writeSaved(key: string, saved: SavedReply | null): void {
  try {
    if (saved) window.localStorage.setItem(key, JSON.stringify(saved));
    else window.localStorage.removeItem(key);
  } catch {
    // Private windows and full storage: the reply simply is not kept.
  }
}

const FORWARD_MARKER = "---------- Forwarded message ----------";

/** The Member's own words in an open editor: a forward's text above the forwarded block. */
function ownWords(state: Pick<ComposerState, "mode" | "body">): string {
  if (state.mode !== "forward") return state.body;
  const at = state.body.indexOf(FORWARD_MARKER);
  return (at === -1 ? state.body : state.body.slice(0, at)).replace(/\s+$/, "");
}

/** What is worth keeping of an open editor — nothing, until the Member wrote something. */
function savedFrom(state: ComposerState): SavedReply | null {
  if (!ownWords(state).trim()) return null;
  return {
    mode: state.mode,
    sourceId: state.source.id,
    headers: mailHeaders(state.fields),
    subject: state.subject,
    body: state.body,
    includeQuote: state.includeQuote,
    forwardIndexes: state.forwardKept,
    savedAt: Date.now(),
  };
}

const MODE_LABELS: Record<ReplyMode, string> = {
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

function ModeIcon({ mode, size = 14 }: { mode: ReplyMode; size?: number }) {
  if (mode === "replyAll") return <ReplyAll size={size} aria-hidden />;
  if (mode === "forward") return <Forward size={size} aria-hidden />;
  return <Reply size={size} aria-hidden />;
}

export const ReplyComposer = React.forwardRef<
  ReplyComposerHandle,
  {
    companyId: string;
    companySlug: string;
    accountId: string;
    selfAddress: string;
    thread: MailThread;
    /** The thread's messages, oldest first. Drafts are ignored. */
    messages: MailMessage[];
    onSent: () => Promise<void>;
    onDraftSaved: () => Promise<void>;
    onScheduleMeeting: () => void;
  }
>(function ReplyComposer(
  {
    companyId,
    companySlug,
    accountId,
    selfAddress,
    thread,
    messages,
    onSent,
    onDraftSaved,
    onScheduleMeeting,
  },
  ref,
) {
  const sent = React.useMemo(() => messages.filter((message) => !message.isDraft), [messages]);
  const newest = sent[sent.length - 1] ?? null;
  const participants = React.useMemo(
    () => threadParticipants(sent, [selfAddress]),
    [sent, selfAddress],
  );
  const draftKey = replyDraftKey(companyId, thread.id);

  const [state, setState] = React.useState<ComposerState | null>(null);
  const [saved, setSaved] = React.useState<SavedReply | null>(() => readSaved(draftKey));
  const [quoteOpen, setQuoteOpen] = React.useState(false);
  const [pending, setPending] = React.useState<"send" | "draft" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fieldsRef = React.useRef<MailRecipientFieldsHandle>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const attach = useMailAttachments(companyId, accountId);
  const clearAttach = attach.clear;
  const { dragActive, onPaste, dragProps } = useComposerFileDrop((files) => attach.addFiles(files));

  React.useEffect(() => {
    setState(null);
    setSaved(readSaved(draftKey));
    setError(null);
    clearAttach();
  }, [draftKey, clearAttach]);

  const blocked = useMailRecipientCheck(
    companyId,
    accountId,
    state?.fields ?? emptyMailRecipients(),
  );

  const start = React.useCallback(
    (mode: ReplyMode, message: MailMessage | null, append?: string) => {
      const source = message ?? newest;
      if (!source) return;
      setError(null);
      setQuoteOpen(false);
      setSaved(null);
      setState((current) => {
        // What the Member already wrote comes along — switching to Reply all,
        // to Forward, or to another message's Reply never throws words away.
        // With nothing open, an unsent reply kept from before is picked up
        // rather than overwritten by an empty one.
        const base = current ? ownWords(current) : saved ? ownWords(saved) : "";
        const withAppend = append
          ? base.trim()
            ? `${base.replace(/\s+$/, "")}\n\n${append}`
            : append
          : base;
        if (mode === "forward") {
          return {
            mode,
            source,
            fields: emptyMailRecipients(),
            subject: forwardSubject(source.subject || thread.subject),
            body: `${withAppend}\n\n${forwardBlock(source)}`,
            quote: null,
            includeQuote: false,
            forwardKept: source.attachments.map((item) => item.index),
          };
        }
        return {
          mode,
          source,
          fields: replyRecipientsFor(source, selfAddress, mode === "replyAll"),
          subject: replySubject(source.subject || thread.subject),
          body: withAppend,
          quote: quotedReply(source),
          includeQuote: true,
          forwardKept: [],
        };
      });
      window.requestAnimationFrame(() => {
        if (mode === "forward") fieldsRef.current?.focus("to");
        else {
          const box = bodyRef.current;
          if (!box) return;
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }
      });
    },
    [newest, selfAddress, thread.subject, saved],
  );

  const resume = () => {
    if (!saved) return;
    const source = sent.find((message) => message.id === saved.sourceId) ?? newest;
    if (!source) return;
    setState({
      mode: saved.mode,
      source,
      fields: mailRecipientsFrom(saved.headers),
      subject: saved.subject,
      body: saved.body,
      quote: saved.mode === "forward" ? null : quotedReply(source),
      includeQuote: saved.includeQuote,
      forwardKept: saved.forwardIndexes.filter((index) =>
        source.attachments.some((item) => item.index === index),
      ),
    });
    window.requestAnimationFrame(() => bodyRef.current?.focus());
  };

  React.useImperativeHandle(
    ref,
    () => ({
      open: (mode, message) => start(mode, message ?? null),
      insertText: (text) => {
        if (state) {
          setState((current) =>
            current
              ? {
                  ...current,
                  body: current.body.trim()
                    ? `${current.body.replace(/\s+$/, "")}\n\n${text}`
                    : text,
                }
              : current,
          );
          window.requestAnimationFrame(() => bodyRef.current?.focus());
        } else {
          start("replyAll", null, text);
        }
      },
    }),
    [start, state],
  );

  // Keep what is being written, so leaving the thread loses nothing.
  React.useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => writeSaved(draftKey, savedFrom(state)), 400);
    return () => window.clearTimeout(timer);
  }, [state, draftKey]);

  /** Close the editor; what was written stays, offered back as Resume. */
  const close = () => {
    const kept = state ? savedFrom(state) : null;
    writeSaved(draftKey, kept);
    setSaved(kept);
    setState(null);
    setError(null);
  };

  const discard = () => {
    writeSaved(draftKey, null);
    setSaved(null);
    setState(null);
    setError(null);
    clearAttach();
  };

  const submit = (kind: "send" | "draft") => {
    if (!state || pending) return;
    const fields = fieldsRef.current?.commit() ?? state.fields;
    const problem = mailRecipientProblem(fields);
    if (problem) {
      setError(problem);
      fieldsRef.current?.focus("to");
      return;
    }
    if (kind === "send" && blocked.length > 0) {
      setError("Remove the recipients who can’t be emailed first.");
      return;
    }
    const bodyText =
      state.mode === "forward"
        ? state.body
        : replyBody(state.body, state.includeQuote ? state.quote : null);
    if (!state.body.trim() && attach.items.length === 0 && state.forwardKept.length === 0) {
      setError("Write something first.");
      bodyRef.current?.focus();
      return;
    }
    const headers = mailHeaders(fields);
    const submitted = { ...state, fields };
    setError(null);
    setPending(kind);
    const input = {
      to: headers.to,
      cc: headers.cc || undefined,
      bcc: headers.bcc || undefined,
      subject: state.subject,
      bodyText,
      threadId: thread.id,
      attachmentIds: attach.ids.length ? attach.ids : undefined,
      forwardFrom:
        state.mode === "forward" && state.forwardKept.length > 0
          ? { messageId: state.source.id, attachmentIndexes: state.forwardKept }
          : undefined,
    };
    const request =
      kind === "send"
        ? mailApi.send(companyId, accountId, input)
        : mailApi.createDraft(companyId, accountId, input);
    request
      .then(() => {
        writeSaved(draftKey, null);
        setSaved(null);
        setState(null);
        clearAttach();
        void (kind === "send" ? onSent() : onDraftSaved());
      })
      .catch((submitError: unknown) => {
        setState(submitted);
        setError(
          `${kind === "send" ? "Couldn’t send" : "Couldn’t save the draft"}: ${errorMessage(submitError, "Request failed")}`,
        );
      })
      .finally(() => setPending(null));
  };

  if (!newest) return null;

  if (!state) {
    return (
      <div className="mt-3 space-y-2">
        {saved && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <ModeIcon mode={saved.mode} size={13} />
            <span className="min-w-0 flex-1 truncate">
              Unsent {MODE_LABELS[saved.mode].toLowerCase()}: {saved.body.trim().split("\n")[0]}
            </span>
            <Button size="sm" variant="secondary" onClick={resume}>
              Resume
            </Button>
            <Button size="sm" variant="ghost" onClick={discard}>
              Discard
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => start("reply", null)}>
            <Reply size={14} className="mr-1.5" /> Reply
          </Button>
          <Button variant="secondary" size="sm" onClick={() => start("replyAll", null)}>
            <ReplyAll size={14} className="mr-1.5" /> Reply all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => start("forward", null)}>
            <Forward size={14} className="mr-1.5" /> Forward
          </Button>
          <Button variant="ghost" size="sm" onClick={onScheduleMeeting}>
            <CalendarPlus size={14} className="mr-1.5" /> Schedule meeting
          </Button>
        </div>
      </div>
    );
  }

  const setFields = (fields: MailRecipients) =>
    setState((current) => (current ? { ...current, fields } : current));
  const forwardFiles: MailAttachment[] =
    state.mode === "forward"
      ? state.source.attachments.filter((item) => state.forwardKept.includes(item.index))
      : [];
  const answering =
    state.source.id !== newest.id
      ? `${state.mode === "forward" ? "Forwarding" : "Replying to"} ${state.source.fromName || state.source.fromEmail}’s message`
      : null;

  return (
    <div
      className="mt-3 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          submit("send");
          return;
        }
        // While writing, the thread's one-key shortcuts are off everywhere in
        // the reply — a letter typed after pressing one of its buttons must
        // never archive, star or trash the conversation.
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.stopPropagation();
        }
      }}
      aria-label={MODE_LABELS[state.mode]}
      role="group"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
        <Menu
          trigger={({ ref: triggerRef, onClick }) => (
            <button
              ref={triggerRef}
              type="button"
              onClick={onClick}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
              aria-label={`${MODE_LABELS[state.mode]} — change`}
            >
              <ModeIcon mode={state.mode} />
              {MODE_LABELS[state.mode]}
              <ChevronDown size={13} className="text-slate-400" aria-hidden />
            </button>
          )}
        >
          {(close) => (
            <>
              {(["reply", "replyAll", "forward"] as const).map((mode) => (
                <MenuItem
                  key={mode}
                  label={MODE_LABELS[mode]}
                  active={state.mode === mode}
                  onSelect={() => {
                    close();
                    if (mode !== state.mode) start(mode, state.source);
                  }}
                />
              ))}
            </>
          )}
        </Menu>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-slate-400">
          {answering ?? mailRecipientsSummary(state.fields)}
        </span>
        <button
          type="button"
          onClick={close}
          title="Close — what you wrote is kept"
          aria-label="Close the reply"
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X size={15} />
        </button>
      </div>

      <div className="px-3 pt-1">
        <MailRecipientFields
          ref={fieldsRef}
          companyId={companyId}
          companySlug={companySlug}
          accountId={accountId}
          value={state.fields}
          onChange={setFields}
          participants={participants}
          selfAddress={selfAddress}
          blocked={blocked}
          disabled={pending !== null}
        />
        {state.mode === "forward" && (
          <div className="flex items-center gap-2 border-t border-slate-100 dark:border-slate-800">
            <span className="w-12 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
              Subject
            </span>
            <input
              value={state.subject}
              onChange={(event) =>
                setState((current) =>
                  current ? { ...current, subject: event.target.value } : current,
                )
              }
              aria-label="Subject"
              maxLength={1000}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-slate-900 focus:outline-none dark:text-slate-100"
            />
          </div>
        )}
      </div>

      <div className="border-t border-slate-100 px-3 pb-3 pt-2 dark:border-slate-800">
        <textarea
          ref={bodyRef}
          value={state.body}
          onChange={(event) =>
            setState((current) => (current ? { ...current, body: event.target.value } : current))
          }
          onPaste={onPaste}
          {...dragProps}
          rows={state.mode === "forward" ? 10 : 6}
          placeholder={state.mode === "forward" ? "Add a note…" : "Write your reply…"}
          aria-label="Your message"
          disabled={pending !== null}
          className={clsx(
            "block w-full resize-y rounded-lg bg-transparent text-sm leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100",
            dragActive && "ring-2 ring-indigo-300 dark:ring-indigo-800",
          )}
        />

        {state.quote && (
          <div className="mt-1">
            {state.includeQuote ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuoteOpen((open) => !open)}
                  aria-expanded={quoteOpen}
                  aria-label={quoteOpen ? "Hide the quoted message" : "Show the quoted message"}
                  title={quoteOpen ? "Hide the quoted message" : "Show the quoted message"}
                  className="flex h-6 items-center rounded-md bg-slate-100 px-2 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
                >
                  <MoreHorizontal size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setState((current) => (current ? { ...current, includeQuote: false } : current))
                  }
                  className="text-xs text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
                >
                  Don’t include the earlier message
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setState((current) => (current ? { ...current, includeQuote: true } : current))
                }
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
              >
                Include the earlier message
              </button>
            )}
            {state.includeQuote && quoteOpen && (
              <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-3 font-sans text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {state.quote}
              </pre>
            )}
          </div>
        )}

        {forwardFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {forwardFiles.map((file) => (
              <span
                key={file.index}
                className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <Paperclip size={12} className="shrink-0 text-slate-400" aria-hidden />
                <span className="max-w-40 truncate">{file.filename}</span>
                <button
                  type="button"
                  // Focus stays where the Member was writing; the button
                  // leaves with the file and must not take the cursor with it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    const hadFocus = document.activeElement === event.currentTarget;
                    setState((current) =>
                      current
                        ? {
                            ...current,
                            forwardKept: current.forwardKept.filter(
                              (index) => index !== file.index,
                            ),
                          }
                        : current,
                    );
                    // Pressed from the keyboard, the focused button is about
                    // to vanish: hand the cursor to the message, not the page.
                    if (hadFocus) window.requestAnimationFrame(() => bodyRef.current?.focus());
                  }}
                  className="text-slate-400 hover:text-red-500"
                  aria-label={`Don’t forward ${file.filename}`}
                  title="Remove"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <FormError message={error} className="mt-2" />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AttachmentBar
            items={attach.items}
            uploading={attach.uploading}
            onAdd={attach.addFiles}
            onRemove={attach.remove}
          />
          <button
            type="button"
            onClick={onScheduleMeeting}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <CalendarPlus size={12} aria-hidden /> Schedule meeting
          </button>
          <div className="ml-auto flex items-center gap-2">
            {pending === "send" && (
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <Spinner size={12} /> Sending…
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={discard}
              disabled={pending !== null}
              title="Discard this reply"
            >
              <Trash2 size={14} className="mr-1.5" /> Discard
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={pending === "draft"}
              disabled={pending !== null || attach.uploading}
              onClick={() => submit("draft")}
            >
              Save draft
            </Button>
            <Button
              size="sm"
              loading={pending === "send"}
              disabled={pending !== null || attach.uploading}
              onClick={() => submit("send")}
              title="Send (⌘↵)"
            >
              <Send size={14} className="mr-1.5" /> Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
