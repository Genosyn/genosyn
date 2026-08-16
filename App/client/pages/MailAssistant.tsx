import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Bot,
  Brain,
  Check,
  ExternalLink,
  FileText,
  Inbox,
  Paperclip,
  Reply,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Company, MessageAction } from "../lib/api";
import {
  ComposeInput,
  MailAccount,
  MailAssistantAttachment,
  MailAssistantMessage,
  MailAssistantModel,
  MailAssistantRosterEntry,
  MailSuggestion,
  mailApi,
} from "../lib/mail";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useDialog } from "../components/ui/Dialog";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { useToast } from "../components/ui/Toast";
import {
  ChatResourceReference,
  insertResourceReference,
  ResourceReferencePicker,
  resourceQueryAtCaret,
  useResourceReferences,
} from "../components/chat/ResourceReferencePicker";

/**
 * The per-email AI chat — a rail beside one opened mail thread where any AI
 * employee can be @-tagged and put to work on that email. Replies come
 * back with action pills (what the employee did) and suggestion buttons
 * (what it proposes the human does next, executed here through the ordinary
 * mail routes with the human's own authority).
 *
 * Every mail thread has its own conversation, streamed over SSE like employee
 * chat. The employee the last reply came from stays on this email's chat until
 * somebody else is tagged.
 *
 * The reply belongs to the server, not to this connection. The turn is
 * persisted as a `working` row before the model starts, so a dropped stream,
 * a closed panel, or a reload picks the same turn back up by polling instead
 * of dead-ending on a network error — and the human never has to guess
 * whether re-sending would duplicate the work.
 */

/** How often a panel that lost its stream re-reads the in-flight turn. */
const FOLLOW_POLL_MS = 2_000;

/** Replace a row by id, or append it when this panel hasn't seen it yet. */
function upsertAssistantMessage(
  prev: MailAssistantMessage[] | null,
  incoming: MailAssistantMessage,
): MailAssistantMessage[] {
  const list = prev ?? [];
  const index = list.findIndex((m) => m.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

/**
 * Fold a freshly fetched conversation into what this panel is showing. The
 * server list wins for anything persisted; purely local rows (an optimistic
 * bubble, a transport-error notice) are kept unless the server now has the
 * real thing.
 */
function mergeAssistantMessages(
  prev: MailAssistantMessage[] | null,
  incoming: MailAssistantMessage[],
): MailAssistantMessage[] {
  if (!prev || prev.length === 0) return incoming;
  const known = new Set(incoming.map((m) => m.id));
  const local = prev.filter((m) => {
    if (known.has(m.id)) return false;
    // A turn accepted while the stream was down persisted the human's
    // message server-side; drop the optimistic twin rather than show both.
    if (m.id.startsWith("temp-") && m.role === "user") {
      return !incoming.some((row) => row.role === "user" && row.content === m.content);
    }
    return true;
  });
  return [...incoming, ...local];
}

/**
 * Only shown once the server has confirmed it has no reply running for this
 * message — so it can say plainly that nothing started, rather than leaving
 * the human guessing whether a retry would duplicate the work.
 */
function formatSendFailure(detail: string): string {
  const clean = detail.replace(/\s+/g, " ").trim() || "Unknown network error";
  return [
    `Genosyn didn’t start a reply to this message: ${clean}`,
    "",
    "Nothing was sent from your mailbox. Check that the Genosyn server is reachable from this browser, then try again.",
  ].join("\n");
}

type Props = {
  company: Company;
  account: MailAccount;
  /** Local thread id that owns this independent AI conversation. */
  threadId: string;
  /** Draft currently in front of the human, when this is a Drafts review. */
  focusedMessageId?: string | null;
  onClose?: () => void;
  openCompose: (init?: Partial<ComposeInput>) => void;
};

export function MailAssistant({
  company,
  account,
  threadId,
  focusedMessageId,
  onClose,
  openCompose,
}: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [messages, setMessages] = React.useState<MailAssistantMessage[] | null>(null);
  const [roster, setRoster] = React.useState<MailAssistantRosterEntry[]>([]);
  const [draft, setDraft] = React.useState("");
  /** True only while this panel holds the live SSE stream for a turn. */
  const [streamOpen, setStreamOpen] = React.useState(false);
  /** True once following the persisted turn has fallen back to polling. */
  const [reconnecting, setReconnecting] = React.useState(false);
  const [streaming, setStreaming] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<{
    id: string;
    name: string;
    slug: string;
  } | null>(null);
  /** Files chosen for the next message — uploaded already, bound on send. */
  const [pending, setPending] = React.useState<MailAssistantAttachment[]>([]);
  const [uploading, setUploading] = React.useState(0);
  /**
   * The brain for the next turn. Null means "whatever the employee's active
   * model is" until the server tells us which one this email's chat has been
   * running on, or the human picks one.
   */
  const [modelId, setModelId] = React.useState<string | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // In-flight SSE turn — aborted when the mailbox changes or the panel
  // unmounts, so a slow reply can't paint into the wrong conversation.
  const streamAbortRef = React.useRef<AbortController | null>(null);

  // ── mention picker state ──
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [resourceQuery, setResourceQuery] = React.useState<string | null>(null);
  const [resourceStart, setResourceStart] = React.useState<number | null>(null);
  const [resourceIndex, setResourceIndex] = React.useState(0);
  const { references, loading: referencesLoading } = useResourceReferences(
    company.id,
    resourceQuery,
  );

  React.useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setTarget(null);
    setDraft("");
    setMentionQuery(null);
    setResourceQuery(null);
    setResourceStart(null);
    setStreaming(null);
    setStreamOpen(false);
    setReconnecting(false);
    setPending([]);
    setModelId(null);
    mailApi
      .assistant(company.id, account.id, threadId)
      .then((res) => {
        if (cancelled) return;
        // Merge rather than replace: a message sent while the bootstrap was
        // in flight must survive (its optimistic bubble isn't in `res`).
        // A `working` row in the response means a turn started elsewhere —
        // another tab, or this panel before it was closed — is still running;
        // the follow effect below takes it from here.
        setMessages((prev) => mergeAssistantMessages(prev, res.messages));
        setRoster(res.roster);
        const lastAnswered = [...res.messages]
          .reverse()
          .find((m) => m.role === "assistant" && m.employeeId);
        if (lastAnswered?.employeeId) {
          const emp = res.roster.find((r) => r.id === lastAnswered.employeeId);
          if (emp) {
            setTarget((cur) => cur ?? { id: emp.id, name: emp.name, slug: emp.slug });
          }
        }
        // Carry on with the brain this email's chat has been using, so
        // reopening the panel doesn't quietly switch models mid-conversation.
        setModelId((cur) => cur ?? res.modelId);
      })
      .catch((err) => {
        if (!cancelled) toast((err as Error).message, "error");
      });
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, account.id, threadId]);

  const scrollToBottom = React.useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, []);

  React.useEffect(() => {
    scrollToBottom();
  }, [messages?.length, streaming, scrollToBottom]);

  // The persisted in-flight turn, if any. It is the panel's single source of
  // truth for "an answer is coming" — the live stream is only the fast path
  // to the same row.
  const workingMessage = React.useMemo(
    () => (messages ?? []).find((m) => m.role === "assistant" && m.status === "working") ?? null,
    [messages],
  );
  const workingId = workingMessage?.id ?? null;
  const turnInFlight = streamOpen || workingId !== null;

  /** The models the employee on this conversation can actually answer on. */
  const targetModels = React.useMemo(
    () => (target ? (roster.find((r) => r.id === target.id)?.models ?? []) : []),
    [target, roster],
  );

  /**
   * What the next turn will run on. A model belonging to a *previous* target
   * is not a valid choice for the employee now on the conversation, so tagging
   * somebody else falls back to their own active model rather than sending an
   * id the server would reject.
   */
  const selectedModelId = React.useMemo(() => {
    if (targetModels.length === 0) return null;
    if (modelId && targetModels.some((m) => m.id === modelId)) return modelId;
    return targetModels.find((m) => m.isActive)?.id ?? targetModels[0].id;
  }, [modelId, targetModels]);

  // Follow a turn this panel is not streaming: the stream dropped, the panel
  // was reopened mid-reply, or another tab started it. Polling the bootstrap
  // is enough — the row finalizes exactly once, whoever is watching.
  React.useEffect(() => {
    if (!workingId || streamOpen) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await mailApi.assistant(company.id, account.id, threadId);
        if (cancelled) return;
        setRoster(res.roster);
        setMessages((prev) => mergeAssistantMessages(prev, res.messages));
        setReconnecting(false);
      } catch {
        // The server may be restarting. Keep waiting: the row outlives it,
        // and boot recovery closes it out if the turn really was lost.
        if (!cancelled) setReconnecting(true);
      }
      if (!cancelled) timer = window.setTimeout(tick, FOLLOW_POLL_MS);
    };
    timer = window.setTimeout(tick, FOLLOW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workingId, streamOpen, company.id, account.id, threadId]);

  // Partial text from a stream that died has already been persisted on the
  // finalized row, so drop the local copy once the turn resolves.
  React.useEffect(() => {
    if (!turnInFlight) {
      setStreaming(null);
      setReconnecting(false);
    }
  }, [turnInFlight]);

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || turnInFlight) return;
      if (message === "/new") {
        try {
          await mailApi.assistantClear(company.id, account.id, threadId);
          setMessages([]);
          setTarget(null);
          setDraft("");
          setPending([]);
          setMentionQuery(null);
          setResourceQuery(null);
          toast("New context started.", "success");
        } catch (err) {
          toast((err as Error).message, "error");
        }
        return;
      }
      setStreamOpen(true);
      setReconnecting(false);
      setDraft("");
      setMentionQuery(null);
      setResourceQuery(null);
      // Hand the files to this turn and clear the tray: a second send must
      // not re-attach what the first one already carried.
      const attachments = pending;
      setPending([]);
      // Optimistic bubble; swapped for the persisted row on the `user` event.
      const temp: MailAssistantMessage = {
        id: `temp-${Date.now()}`,
        accountId: account.id,
        threadId,
        role: "user",
        employeeId: null,
        modelId: null,
        content: message,
        status: null,
        actions: [],
        suggestions: [],
        attachments,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...(prev ?? []), temp]);
      // Once the server has persisted the in-flight row, this stream is only
      // a subscriber: losing it is not losing the reply.
      let accepted = false;
      let accumulated = "";
      const controller = new AbortController();
      streamAbortRef.current?.abort();
      streamAbortRef.current = controller;
      try {
        await mailApi.assistantSend(
          company.id,
          account.id,
          {
            message,
            threadId,
            focusedMessageId: focusedMessageId ?? undefined,
            employeeId: target?.id,
            attachmentIds: attachments.map((a) => a.id),
            modelId: selectedModelId,
          },
          (event, data) => {
            if (event === "user") {
              const row = data as MailAssistantMessage;
              setMessages((prev) => (prev ?? []).map((m) => (m.id === temp.id ? row : m)));
            } else if (event === "target") {
              const emp = (
                data as {
                  employee: { id: string; name: string; slug: string } | null;
                }
              ).employee;
              setTarget(emp);
            } else if (event === "working") {
              accepted = true;
              setMessages((prev) => upsertAssistantMessage(prev, data as MailAssistantMessage));
            } else if (event === "chunk") {
              accumulated += (data as { text: string }).text;
              setStreaming(accumulated);
            } else if (event === "assistant") {
              accepted = true;
              setStreaming(null);
              setMessages((prev) => upsertAssistantMessage(prev, data as MailAssistantMessage));
            } else if (event === "error") {
              throw new Error((data as { message: string }).message);
            }
          },
          { signal: controller.signal },
        );
      } catch (err) {
        // A deliberate cancel (mailbox switch, unmount) is not an error the
        // human needs a bubble for. Neither is a dropped connection once the
        // turn was accepted: the follow effect polls that row to its answer.
        const aborted = (err as Error).name === "AbortError" || controller.signal.aborted;
        if (aborted) return;
        if (!accepted) {
          // The connection can also die between the server accepting the turn
          // and this stream hearing about it. Ask the server before telling
          // the human nothing ran — the answer decides which is true.
          try {
            const res = await mailApi.assistant(company.id, account.id, threadId);
            setRoster(res.roster);
            setMessages((prev) => mergeAssistantMessages(prev, res.messages));
            accepted = res.messages.some((m) => m.role === "assistant" && m.status === "working");
          } catch {
            // Server unreachable; fall through to the honest failure below.
          }
        }
        if (accepted) {
          setReconnecting(true);
          return;
        }
        setMessages((prev) => [
          ...(prev ?? []),
          {
            ...temp,
            id: `temp-err-${Date.now()}`,
            role: "assistant",
            status: "error",
            content: formatSendFailure((err as Error).message),
            attachments: [],
          },
        ]);
      } finally {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        setStreamOpen(false);
        scrollToBottom();
      }
    },
    [
      turnInFlight,
      company.id,
      account.id,
      threadId,
      focusedMessageId,
      target,
      pending,
      selectedModelId,
      scrollToBottom,
      toast,
    ],
  );

  /**
   * Files are uploaded the moment they're chosen, so the send payload is just
   * ids and a failed upload is reported while the human is still composing —
   * not after they hit send.
   */
  const addFiles = React.useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        setUploading((n) => n + 1);
        try {
          const attachment = await mailApi.assistantUpload(company.id, account.id, file);
          setPending((prev) => [...prev, attachment]);
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setUploading((n) => n - 1);
        }
      }
    },
    [company.id, account.id, toast],
  );

  /**
   * Re-run the human message that produced a failed reply. The panel knows
   * exactly which one it was, so recovering from an interrupted turn is one
   * click rather than scrolling up and retyping.
   */
  const retryFrom = React.useCallback(
    (failed: MailAssistantMessage) => {
      const list = messages ?? [];
      const index = list.findIndex((m) => m.id === failed.id);
      for (let i = index - 1; i >= 0; i -= 1) {
        if (list[i].role === "user") {
          void send(list[i].content);
          return;
        }
      }
    },
    [messages, send],
  );

  const markExecuted = React.useCallback((updated: MailAssistantMessage) => {
    setMessages((prev) => (prev ?? []).map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  const clearConversation = async () => {
    try {
      await mailApi.assistantClear(company.id, account.id, threadId);
      setMessages([]);
      setTarget(null);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  // ── mention picker mechanics ──

  const mentionCandidates = React.useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return roster.filter((r) => r.slug.includes(q) || r.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mentionQuery, roster]);

  const refreshMentionState = (value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const match = /(^|[\s(])@([a-z0-9-]*)$/i.exec(upToCaret);
    const resource = resourceQueryAtCaret(value, caret);
    setMentionQuery(match ? match[2] : null);
    setResourceQuery(resource?.query ?? null);
    setResourceStart(resource?.start ?? null);
    setMentionIndex(0);
    setResourceIndex(0);
  };

  const insertMention = (emp: MailAssistantRosterEntry) => {
    const el = textareaRef.current;
    const caret = el ? el.selectionStart : draft.length;
    const upToCaret = draft.slice(0, caret);
    // The picker can outlive the caret (it only re-syncs on change/select
    // events) — if there's no @token at the caret anymore, just close it
    // rather than splicing a mention into the wrong place.
    if (!/@([a-z0-9-]*)$/i.test(upToCaret)) {
      setMentionQuery(null);
      return;
    }
    const replaced = upToCaret.replace(/@([a-z0-9-]*)$/i, `@${emp.slug} `);
    const next = replaced + draft.slice(caret);
    setDraft(next);
    setMentionQuery(null);
    setTarget({ id: emp.id, name: emp.name, slug: emp.slug });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(replaced.length, replaced.length);
    });
  };

  const insertReference = (reference: ChatResourceReference) => {
    const el = textareaRef.current;
    if (!el || resourceStart === null) return;
    const inserted = insertResourceReference({
      value: draft,
      caret: el.selectionStart ?? draft.length,
      start: resourceStart,
      companySlug: company.slug,
      reference,
    });
    setDraft(inserted.value);
    setMentionQuery(null);
    setResourceQuery(null);
    setResourceStart(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (resourceQuery !== null && references.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setResourceIndex((index) => (index + 1) % references.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setResourceIndex((index) => (index - 1 + references.length) % references.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertReference(references[resourceIndex] ?? references[0]);
        return;
      }
      if (e.key === "Escape") {
        setResourceQuery(null);
        return;
      }
    }
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  const quickPrompts = focusedMessageId
    ? [
        "Make this draft clearer and more concise.",
        "Check this draft against the conversation and fix anything missing.",
        "Improve the tone and grammar of this draft.",
      ]
    : [
        "Summarize this email and what it needs from me.",
        "Draft a reply to this email.",
        "Triage this email — label it and archive if nothing is needed.",
      ];

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-violet-500/15">
          <Sparkles size={14} className="text-violet-600 dark:text-violet-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Ask AI</div>
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {target ? `Working with ${target.name}` : "A separate chat for this email"}
          </div>
        </div>
        {messages !== null && messages.length > 0 && (
          <button
            onClick={() => void clearConversation()}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Clear conversation"
          >
            <Trash2 size={14} />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Close"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : messages.length === 0 && !streaming ? (
          <IntroTips
            roster={roster}
            companyId={company.id}
            prompts={quickPrompts}
            onPick={(p) => {
              setDraft(p);
              textareaRef.current?.focus();
            }}
          />
        ) : (
          <>
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                company={company}
                account={account}
                roster={roster}
                openCompose={openCompose}
                navigate={(to) => navigate(to)}
                onExecuted={markExecuted}
                onRetry={retryFrom}
                streamingText={m.id === workingId ? streaming : null}
                reconnecting={m.id === workingId && reconnecting}
              />
            ))}
          </>
        )}
        {streamOpen && workingId === null && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Spinner size={12} />
            {target ? `${target.name} is thinking…` : "Thinking…"}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="relative border-t border-slate-200 p-3 dark:border-slate-800">
        {mentionQuery !== null && resourceQuery === null && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 z-10 mb-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {mentionCandidates.map((r, i) => (
              <button
                key={r.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(r);
                }}
                className={clsx(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                  i === mentionIndex
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800",
                )}
              >
                <Avatar
                  name={r.name}
                  src={employeeAvatarUrl(company.id, r.id, r.avatarKey)}
                  kind="ai"
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                    {r.name}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">
                    @{r.slug}
                    {!r.hasModel
                      ? " · no model connected"
                      : r.accessLevel
                        ? ` · ${r.accessLevel} access`
                        : " · no mailbox access"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {resourceQuery !== null && (
          <ResourceReferencePicker
            references={references}
            loading={referencesLoading}
            activeIndex={resourceIndex}
            onHover={setResourceIndex}
            onPick={insertReference}
            className="absolute bottom-full left-3 right-3 z-10 mb-1"
          />
        )}
        {pending.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {pending.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <FileText size={11} className="shrink-0 text-slate-400" />
                <span className="max-w-40 truncate">{a.filename}</span>
                <span className="text-slate-400">{formatBytes(a.sizeBytes)}</span>
                <button
                  type="button"
                  onClick={() => setPending((prev) => prev.filter((p) => p.id !== a.id))}
                  className="text-slate-400 hover:text-rose-500"
                  title="Remove"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 focus-within:border-indigo-400 dark:border-slate-700 dark:bg-slate-900">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={turnInFlight}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Attach a file"
          >
            {uploading > 0 ? <Spinner size={12} /> : <Paperclip size={14} />}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={2}
            placeholder={
              turnInFlight
                ? `${target?.name ?? "The employee"} is still on your last message…`
                : "Ask AI to summarize, reply, edit, or triage…"
            }
            onChange={(e) => {
              setDraft(e.target.value);
              refreshMentionState(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              // Caret moves (arrows, clicks) must re-sync the picker so a
              // stale Enter can't insert a mention at the wrong spot.
              const el = e.currentTarget;
              refreshMentionState(el.value, el.selectionStart);
            }}
            onBlur={() => {
              setMentionQuery(null);
              setResourceQuery(null);
            }}
            onKeyDown={onComposerKeyDown}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <button
            onClick={() => void send(draft)}
            disabled={!draft.trim() || turnInFlight}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white transition-opacity hover:bg-indigo-500 disabled:opacity-40"
            title="Send (Enter)"
          >
            <Send size={14} />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400 dark:text-slate-500">
          <span>
            <span className="font-mono">@</span> AI employee · <span className="font-mono">#</span>{" "}
            resource · <span className="font-mono">/new</span> new context
          </span>
          {targetModels.length > 1 && (
            <label className="inline-flex shrink-0 items-center gap-1.5">
              <Brain size={11} aria-hidden="true" />
              <span className="sr-only">AI Model for this message</span>
              <Select
                aria-label="AI Model for this message"
                value={selectedModelId ?? ""}
                onChange={(event) => setModelId(event.target.value)}
                className="max-w-44 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 outline-none transition focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                {targetModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {assistantModelLabel(model)}
                    {model.isActive ? " (active)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

function assistantModelLabel(model: MailAssistantModel): string {
  const provider =
    model.provider === "openai"
      ? "OpenAI"
      : model.provider === "anthropic"
        ? "Anthropic"
        : "Custom";
  return `${provider} · ${model.model}`;
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ───────────────────────────── empty state ─────────────────────────────

function IntroTips({
  roster,
  companyId,
  prompts,
  onPick,
}: {
  roster: MailAssistantRosterEntry[];
  companyId: string;
  prompts: string[];
  onPick: (p: string) => void;
}) {
  const taggable = roster.filter((r) => r.hasModel);
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <Bot size={15} className="text-violet-500" /> Work on this email with AI
      </div>
      <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        Tag anyone with <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">@</code> and
        ask them to summarize, draft, edit, triage, or clean up. This email keeps its own chat, and
        employees act within their mailbox access.
      </p>
      {taggable.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {taggable.slice(0, 5).map((r) => (
            <button
              key={r.id}
              onClick={() => onPick(`@${r.slug} `)}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 py-0.5 pl-0.5 pr-2 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
            >
              <Avatar
                name={r.name}
                src={employeeAvatarUrl(companyId, r.id, r.avatarKey)}
                kind="ai"
                size="xs"
              />
              {r.name}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="block w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-left text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700 dark:border-slate-800 dark:text-slate-400 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/5 dark:hover:text-indigo-300"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── message row ─────────────────────────────

function MessageRow({
  message,
  company,
  account,
  roster,
  openCompose,
  navigate,
  onExecuted,
  onRetry,
  streamingText,
  reconnecting,
}: {
  message: MailAssistantMessage;
  company: Company;
  account: MailAccount;
  roster: MailAssistantRosterEntry[];
  openCompose: (init?: Partial<ComposeInput>) => void;
  navigate: (to: string) => void;
  onExecuted: (updated: MailAssistantMessage) => void;
  onRetry: (message: MailAssistantMessage) => void;
  /** Live deltas for an in-flight row this panel is streaming. */
  streamingText?: string | null;
  /** This panel lost the stream and is polling the row instead. */
  reconnecting?: boolean;
}) {
  const attachmentUrl = (id: string) =>
    mailApi.assistantAttachmentUrl(company.id, account.id, id);

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] break-words rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white [&_a]:text-white [&_a]:underline">
          <ChatMarkdown content={message.content} />
        </div>
        {message.attachments.length > 0 && (
          <AttachmentChips attachments={message.attachments} urlFor={attachmentUrl} align="end" />
        )}
      </div>
    );
  }

  const emp = message.employeeId ? roster.find((r) => r.id === message.employeeId) : undefined;
  const isError = message.status === "error";
  const isSkipped = message.status === "skipped";
  const isWorking = message.status === "working";
  // A skipped turn ran nothing and an error turn ended early — both are worth
  // one click to re-run. The exception is the server-side "tag somebody"
  // notice (an error row with nobody on it): re-sending the same untagged
  // message would only earn the same instruction back.
  const untargetedNotice = isError && !message.employeeId && !message.id.startsWith("temp-");
  const canRetry = (isError || isSkipped) && !untargetedNotice;

  return (
    <div className="flex items-start gap-2">
      {emp ? (
        <Avatar
          name={emp.name}
          src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
          kind="ai"
          size="sm"
          className="mt-0.5"
        />
      ) : (
        <div
          className={clsx(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            isError ? "bg-rose-100 dark:bg-rose-500/15" : "bg-violet-100 dark:bg-violet-500/15",
          )}
        >
          {isError ? (
            <AlertTriangle size={12} className="text-rose-600 dark:text-rose-300" />
          ) : (
            <Bot size={12} className="text-violet-600 dark:text-violet-300" />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] text-slate-400 dark:text-slate-500">
          {emp?.name ?? "Email AI"}
          {isSkipped ? " · skipped" : ""}
          {isWorking ? (reconnecting ? " · reconnecting" : " · working") : ""}
        </div>
        <div
          className={clsx(
            "rounded-lg px-3 py-2 text-sm",
            isError
              ? "bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200"
              : isSkipped
                ? "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
                : "bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
          )}
        >
          {isWorking ? (
            <WorkingBody
              name={emp?.name ?? "The employee"}
              text={streamingText ?? null}
              reconnecting={Boolean(reconnecting)}
            />
          ) : isError || isSkipped ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <ChatMarkdown content={message.content} />
          )}
        </div>
        {message.attachments.length > 0 && (
          <AttachmentChips attachments={message.attachments} urlFor={attachmentUrl} align="start" />
        )}
        {canRetry && (
          <button
            onClick={() => onRetry(message)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
          >
            <RotateCcw size={11} /> Try again
          </button>
        )}
        {message.actions.length > 0 && <ActionPills actions={message.actions} />}
        {message.suggestions.length > 0 && (
          <SuggestionButtons
            message={message}
            company={company}
            account={account}
            openCompose={openCompose}
            navigate={navigate}
            onExecuted={onExecuted}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The in-flight reply. Shows live text when this panel holds the stream, and
 * an honest "still running, still connected to it" line when it doesn't —
 * a reply being written somewhere else is not the same as a lost one.
 */
function WorkingBody({
  name,
  text,
  reconnecting,
}: {
  name: string;
  text: string | null;
  reconnecting: boolean;
}) {
  if (text) {
    return (
      <div>
        <ChatMarkdown content={text} />
        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-slate-400 align-middle" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
      <Spinner size={12} />
      {reconnecting
        ? `Reconnecting — ${name} is still working on this, and the reply will appear here.`
        : `${name} is working…`}
    </div>
  );
}

/**
 * Files on a turn: what the teammate uploaded, and what the employee produced
 * (a filled form, a generated document). Rendered as download chips rather
 * than inline previews — the panel is a narrow rail beside the email, and
 * these are usually documents to keep, not images to look at.
 */
function AttachmentChips({
  attachments,
  urlFor,
  align,
}: {
  attachments: MailAssistantAttachment[];
  urlFor: (id: string) => string;
  align: "start" | "end";
}) {
  return (
    <div
      className={clsx(
        "mt-1.5 flex flex-wrap gap-1.5",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {attachments.map((a) => (
        <a
          key={a.id}
          href={urlFor(a.id)}
          download={a.filename}
          title={`Download ${a.filename}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500/50 dark:hover:text-indigo-300"
        >
          <FileText size={11} className="shrink-0 text-slate-400" />
          <span className="max-w-[180px] truncate">{a.filename}</span>
          <span className="shrink-0 text-slate-400">{formatBytes(a.sizeBytes)}</span>
        </a>
      ))}
    </div>
  );
}

/** Compact "what the employee did" chips — evidence from AuditEvents. */
function ActionPills({ actions }: { actions: MessageAction[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
          title={a.targetLabel ?? a.action}
        >
          <Check size={10} className="text-emerald-500" />
          <span className="max-w-[180px] truncate">{describeAction(a)}</span>
        </span>
      ))}
    </div>
  );
}

function describeAction(a: MessageAction): string {
  const label = a.targetLabel ? ` "${a.targetLabel}"` : "";
  switch (a.action) {
    case "mail.draft.create":
      return `Drafted${label}`;
    case "mail.draft.update":
      return `Edited${label}`;
    case "mail.send":
      return `Sent${label}`;
    case "mail.thread.action":
      return `Triaged${label}`;
    case "mail.handover.create":
      return `Handed over${label}`;
    default:
      return `${a.action}${label}`;
  }
}

// ───────────────────────────── suggestion buttons ─────────────────────────────

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

/**
 * The one-click buttons an employee proposed. Consuming actions
 * (send/triage/handover/rule) are stamped executed server-side so a reload
 * can't re-arm them; opening a composer or a thread stays repeatable.
 */
function SuggestionButtons({
  message,
  company,
  account,
  openCompose,
  navigate,
  onExecuted,
}: {
  message: MailAssistantMessage;
  company: Company;
  account: MailAccount;
  openCompose: (init?: Partial<ComposeInput>) => void;
  navigate: (to: string) => void;
  onExecuted: (updated: MailAssistantMessage) => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const markExecuted = async (s: MailSuggestion) => {
    try {
      const res = await mailApi.assistantMarkExecuted(company.id, message.id, s.id);
      onExecuted(res.message);
    } catch {
      // Non-fatal: the action itself succeeded; the stamp is bookkeeping.
    }
  };

  const run = async (s: MailSuggestion) => {
    if (busyId || s.executedAt) return;
    setBusyId(s.id);
    try {
      switch (s.kind) {
        case "reply": {
          // The tool contract lets a reply carry just threadId + bodyText;
          // resolve the recipients the same way ReplyComposer does so the
          // composer opens sendable.
          let to = s.to;
          let cc = s.cc;
          if (s.threadId && !to) {
            const rec = await mailApi.replyRecipients(company.id, s.threadId).catch(() => null);
            to = rec?.to;
            cc = cc ?? (rec?.cc || undefined);
          }
          openCompose({
            to,
            cc,
            subject: s.subject,
            bodyText: s.bodyText ?? "",
            threadId: s.threadId,
          });
          break;
        }
        case "open_thread":
          navigate(`/c/${company.slug}/mail/t/${s.threadId}`);
          break;
        case "send_draft": {
          // The button label is model-authored; the recipient/subject shown
          // here are the server-verified snapshot. Mail leaves the building
          // only after the human has seen where it's going.
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
          toast("Sent", "success");
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
          toast("Done", "success");
          await markExecuted(s);
          break;
        }
        case "hand_over":
          await mailApi.createHandover(company.id, s.threadId!, {
            employeeId: s.employeeId!,
            instruction: s.instruction ?? "",
            mode: s.mode ?? "draft",
          });
          toast("Handover started", "success");
          await markExecuted(s);
          break;
        case "create_rule":
          await mailApi.createRule(company.id, s.accountId ?? account.id, {
            name: s.rule!.name,
            enabled: true,
            conditions: s.rule!.conditions,
            actions: s.rule!.actions,
          });
          toast("Rule created — see Automation → Rules", "success");
          await markExecuted(s);
          break;
      }
    } catch (err) {
      toast((err as Error).message, "error");
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

/**
 * Server-verified context shown under the model-authored label, so the
 * human approves the checked target — not the label's claim about it.
 */
function verifiedTarget(s: MailSuggestion): string | null {
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

function suggestionHint(s: MailSuggestion): string {
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
