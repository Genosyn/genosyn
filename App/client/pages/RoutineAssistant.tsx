import React from "react";
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  FileText,
  Paperclip,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Company, MessageAction, RoutineWithMeta } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  RoutineAssistantAttachment,
  RoutineAssistantMessage,
  RoutineAssistantModel,
  RoutineAssistantRosterEntry,
  routineAssistantApi,
} from "../lib/routineAssistant";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useDialog } from "../components/ui/Dialog";
import { FormError } from "../components/ui/FormError";
import { Select } from "../components/ui/Select";
import {
  SidePanelCollapseIcon,
  SidePanelResizeHandle,
  useSidePanelWidth,
  useWideViewport,
} from "../components/ui/SidePanel";
import { SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT } from "../components/ui/sidePanelWidth";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import {
  ChatResourceReference,
  insertResourceReference,
  ResourceReferencePicker,
  resourceQueryAtCaret,
  useResourceReferences,
} from "../components/chat/ResourceReferencePicker";

/**
 * Ask AI — the rail beside one opened Routine, where any AI employee can be
 * @-tagged and asked about it: what this routine does, why last night's Run
 * failed, whether the schedule is what the brief says it is.
 *
 * Built like the per-email chat, because it is the same idea pointed at a
 * different noun. Every routine has its own conversation, streamed over SSE.
 * The employee the last reply came from stays on this routine's chat until
 * somebody else is tagged; it starts on the routine's own employee.
 *
 * The reply belongs to the server, not to this connection. The turn is
 * persisted as a `working` row before the model starts, so a dropped stream,
 * a closed panel, or a reload picks the same turn back up by polling instead
 * of dead-ending on a network error — and the human never has to guess
 * whether re-sending would duplicate the work.
 */

/** How often a panel that lost its stream re-reads the in-flight turn. */
const FOLLOW_POLL_MS = 2_000;

const WIDTH_STORAGE_KEY = "genosyn.routineAssistant.width";

/** Replace a row by id, or append it when this panel hasn't seen it yet. */
function upsertAssistantMessage(
  prev: RoutineAssistantMessage[] | null,
  incoming: RoutineAssistantMessage,
): RoutineAssistantMessage[] {
  const list = prev ?? [];
  const index = list.findIndex((m) => m.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}

/**
 * Fold a server page into what this panel already has.
 *
 * Replacing outright would drop an optimistic bubble sent while the bootstrap
 * was in flight; appending outright would duplicate every row. So: server rows
 * win by id, and anything local the server hasn't heard of yet (a `temp-`
 * bubble) is kept at the end.
 */
function mergeAssistantMessages(
  prev: RoutineAssistantMessage[] | null,
  incoming: RoutineAssistantMessage[],
): RoutineAssistantMessage[] {
  if (!prev || prev.length === 0) return incoming;
  const known = new Set(incoming.map((m) => m.id));
  const local = prev.filter((m) => {
    if (known.has(m.id)) return false;
    // A turn accepted while the stream was down persisted the human's
    // message server-side under a real id, so the optimistic twin can only be
    // recognised by what it says. Matching on id alone would leave the
    // question rendered twice, the second copy stranded below the reply.
    if (m.id.startsWith("temp-") && m.role === "user") {
      return !incoming.some((row) => row.role === "user" && row.content === m.content);
    }
    return true;
  });
  return [...incoming, ...local];
}

function formatSendFailure(detail: string): string {
  const clean = detail.replace(/\s+/g, " ").trim();
  return [
    "This message couldn’t be sent.",
    "",
    `Details: ${clean || "Unknown error"}`,
    "",
    "Nothing about the routine was changed. Try again in a moment.",
  ].join("\n");
}

type Props = {
  company: Company;
  routine: RoutineWithMeta;
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  onClose: () => void;
};

export function RoutineAssistant({
  company,
  routine,
  collapsed,
  onCollapsedChange,
  onClose,
}: Props) {
  const dialog = useDialog();
  const { width, resizing, startResize, onResizeKeyDown } = useSidePanelWidth(WIDTH_STORAGE_KEY);
  const wide = useWideViewport(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT);
  const [messages, setMessages] = React.useState<RoutineAssistantMessage[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [roster, setRoster] = React.useState<RoutineAssistantRosterEntry[]>([]);
  const [draft, setDraft] = React.useState("");
  /** Failure of something started from the composer — a /new, an upload. */
  const [composerError, setComposerError] = React.useState<string | null>(null);
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
  const [pending, setPending] = React.useState<RoutineAssistantAttachment[]>([]);
  const [uploading, setUploading] = React.useState(0);
  /**
   * The brain for the next turn. Null means "whatever the employee's active
   * model is" until the server tells us which one this routine's chat has been
   * running on, or the human picks one.
   */
  const [modelId, setModelId] = React.useState<string | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // In-flight SSE turn — aborted when the routine changes or the panel
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

  const routineId = routine.id;

  React.useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setLoadError(null);
    setComposerError(null);
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
    routineAssistantApi
      .load(company.id, routineId)
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
        const startOn = lastAnswered?.employeeId
          ? res.roster.find((r) => r.id === lastAnswered.employeeId)
          : res.roster.find((r) => r.ownsRoutine);
        if (startOn) {
          setTarget((cur) => cur ?? { id: startOn.id, name: startOn.name, slug: startOn.slug });
        }
        // Carry on with the brain this routine's chat has been using, so
        // reopening the panel doesn't quietly switch models mid-conversation.
        setModelId((cur) => cur ?? res.modelId);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err, "Could not load this routine’s chat"));
      });
    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, routineId]);

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
        const res = await routineAssistantApi.load(company.id, routineId);
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
  }, [workingId, streamOpen, company.id, routineId]);

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
      setComposerError(null);
      if (message === "/new") {
        try {
          await routineAssistantApi.clear(company.id, routineId);
          setMessages([]);
          setTarget(null);
          setDraft("");
          setPending([]);
          setMentionQuery(null);
          setResourceQuery(null);
        } catch (err) {
          setComposerError(errorMessage(err, "Could not start a new context"));
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
      const temp: RoutineAssistantMessage = {
        id: `temp-${Date.now()}`,
        routineId,
        role: "user",
        employeeId: null,
        modelId: null,
        content: message,
        status: null,
        actions: [],
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
        await routineAssistantApi.send(
          company.id,
          routineId,
          {
            message,
            employeeId: target?.id,
            attachmentIds: attachments.map((a) => a.id),
            modelId: selectedModelId,
          },
          (event, data) => {
            if (event === "user") {
              const row = data as RoutineAssistantMessage;
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
              setMessages((prev) => upsertAssistantMessage(prev, data as RoutineAssistantMessage));
            } else if (event === "chunk") {
              accumulated += (data as { text: string }).text;
              setStreaming(accumulated);
            } else if (event === "assistant") {
              accepted = true;
              setStreaming(null);
              setMessages((prev) => upsertAssistantMessage(prev, data as RoutineAssistantMessage));
            } else if (event === "error") {
              throw new Error((data as { message: string }).message);
            }
          },
          { signal: controller.signal },
        );
      } catch (err) {
        // A deliberate cancel (routine switch, unmount) is not an error the
        // human needs a bubble for. Neither is a dropped connection once the
        // turn was accepted: the follow effect polls that row to its answer.
        const aborted = (err as Error).name === "AbortError" || controller.signal.aborted;
        if (aborted) return;
        if (!accepted) {
          // The connection can also die between the server accepting the turn
          // and this stream hearing about it. Ask the server before telling
          // the human nothing ran — the answer decides which is true.
          try {
            const res = await routineAssistantApi.load(company.id, routineId);
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
    [turnInFlight, company.id, routineId, target, pending, selectedModelId, scrollToBottom],
  );

  /**
   * Files are uploaded the moment they're chosen, so the send payload is just
   * ids and a failed upload is reported while the human is still composing —
   * not after they hit send.
   */
  const addFiles = React.useCallback(
    async (files: FileList | File[]) => {
      setComposerError(null);
      for (const file of Array.from(files)) {
        setUploading((n) => n + 1);
        try {
          const attachment = await routineAssistantApi.upload(company.id, routineId, file);
          setPending((prev) => [...prev, attachment]);
        } catch (err) {
          setComposerError(errorMessage(err, `Could not upload ${file.name}`));
        } finally {
          setUploading((n) => n - 1);
        }
      }
    },
    [company.id, routineId],
  );

  /**
   * Re-run the human message that produced a failed reply. The panel knows
   * exactly which one it was, so recovering from an interrupted turn is one
   * click rather than scrolling up and retyping.
   */
  const retryFrom = React.useCallback(
    (failed: RoutineAssistantMessage) => {
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

  const clearConversation = async () => {
    try {
      await routineAssistantApi.clear(company.id, routineId);
      setMessages([]);
      setTarget(null);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t clear the conversation" });
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

  const insertMention = (emp: RoutineAssistantRosterEntry) => {
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

  // Written against what this routine actually is right now, so the openers
  // are worth clicking rather than generic filler.
  const quickPrompts = React.useMemo(() => {
    const list: string[] = ["What does this routine actually do, in plain terms?"];
    const lastStatus = routine.lastRun?.status;
    if (lastStatus && lastStatus !== "completed") {
      list.push(
        `The last run ${lastStatus === "timeout" ? "timed out" : `ended ${lastStatus}`} — why?`,
      );
    } else {
      list.push("Summarize how the recent runs went.");
    }
    if (!routine.enabled) {
      list.push("This routine is paused. What would happen if I turned it back on?");
    } else if (routine.nextRunAt === null) {
      list.push("This routine never fires. What's wrong with the schedule?");
    } else {
      list.push("Is the brief still right for what this routine should be doing?");
    }
    return list;
  }, [routine.lastRun?.status, routine.enabled, routine.nextRunAt]);

  // The rail is offered on a narrow window too. Ignoring `collapsed` there
  // would turn a wound-down panel into a full-screen takeover the moment
  // someone resized, and would leave no way back other than closing it.
  if (collapsed) {
    return (
      <aside
        className="relative flex h-full w-11 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
        aria-label="Ask AI about this routine"
      >
        <button
          onClick={() => onCollapsedChange(false)}
          className="flex h-full w-full flex-col items-center gap-2 py-3 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          title="Show Ask AI"
        >
          <Sparkles size={16} />
          <span className="rotate-180 text-[10px] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
            Ask AI
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={
        wide
          ? "relative flex h-full min-h-0 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950" +
            (resizing ? "" : " transition-[width] duration-200")
          : // Too narrow to sit beside the routine: take the pane instead of
            // squeezing both into a pair of slivers.
            "absolute inset-0 z-30 flex min-h-0 flex-col bg-white dark:bg-slate-950"
      }
      style={wide ? { width } : undefined}
      aria-label="Ask AI about this routine"
    >
      {wide && (
        <SidePanelResizeHandle
          label="Resize the Ask AI panel"
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
          active={resizing}
        />
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/15">
          <Sparkles size={14} className="text-violet-600 dark:text-violet-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Ask AI</div>
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {target ? `Working with ${target.name}` : "A separate chat for this routine"}
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
        {wide && (
          <button
            onClick={() => onCollapsedChange(true)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Collapse"
            aria-label="Collapse the Ask AI panel"
          >
            <SidePanelCollapseIcon />
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          title="Close"
          aria-label="Close the Ask AI panel"
        >
          <X size={15} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {loadError && messages === null ? (
          <FormError message={loadError} />
        ) : messages === null ? (
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
                routineId={routineId}
                roster={roster}
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
      <div className="relative shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
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
                      : r.ownsRoutine
                        ? " · owns this routine"
                        : ""}
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
        <FormError message={composerError} className="mb-1.5" />
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
                : "Ask about this routine, its schedule, or its runs…"
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
    </aside>
  );
}

function assistantModelLabel(model: RoutineAssistantModel): string {
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
  roster: RoutineAssistantRosterEntry[];
  companyId: string;
  prompts: string[];
  onPick: (p: string) => void;
}) {
  // Whoever owns the routine first: they are who the panel talks to by
  // default, so they belong at the front of the row.
  const taggable = roster
    .filter((r) => r.hasModel)
    .sort((a, b) => Number(b.ownsRoutine) - Number(a.ownsRoutine));
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <Bot size={15} className="text-violet-500" /> Ask about this routine
      </div>
      <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The employee that owns this routine answers by default — they can see its brief, its
        schedule, and the log of the newest Run. Tag anyone else with{" "}
        <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">@</code>. This routine keeps
        its own chat.
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
  routineId,
  roster,
  onRetry,
  streamingText,
  reconnecting,
}: {
  message: RoutineAssistantMessage;
  company: Company;
  routineId: string;
  roster: RoutineAssistantRosterEntry[];
  onRetry: (message: RoutineAssistantMessage) => void;
  /** Live deltas for an in-flight row this panel is streaming. */
  streamingText?: string | null;
  /** This panel lost the stream and is polling the row instead. */
  reconnecting?: boolean;
}) {
  const attachmentUrl = (id: string) =>
    routineAssistantApi.attachmentUrl(company.id, routineId, id);

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
          {emp?.name ?? "Routine AI"}
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
 * Files on a turn: what the teammate uploaded, and what the employee produced.
 * Rendered as download chips rather than inline previews — the panel is a
 * narrow rail, and these are usually documents to keep.
 */
function AttachmentChips({
  attachments,
  urlFor,
  align,
}: {
  attachments: RoutineAssistantAttachment[];
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
    case "routine.create":
      return `Created routine${label}`;
    case "routine.update":
      return `Updated routine${label}`;
    case "routine.delete":
      return `Deleted routine${label}`;
    default:
      return `${a.action}${label}`;
  }
}
