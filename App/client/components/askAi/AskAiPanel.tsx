import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDown,
  AtSign,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleSlash,
  Clock,
  FileText,
  History,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { Company, MessageAction } from "@/lib/api";
import { focusOnArrival } from "@/lib/composerFocus";
import {
  askAiApi,
  askAiModelLabel,
  insertMention,
  mentionQueryAtCaret,
  mentionedRosterIds,
  plannedTargets,
  reusableConversationId,
  soleAnswerer,
  type AskAiContextItem,
  type AskAiContextPreview,
  type AskAiConversation,
  type AskAiMessage,
  type AskAiRosterEntry,
  type AskAiSendInput,
} from "@/lib/askAi";
import {
  useAssistantChatSession,
  type AssistantChatBootstrap,
  type AssistantQueuedMessage,
} from "@/lib/assistantChatSessions";
import { chatRetryText } from "@/lib/chatRetry";
import { errorMessage } from "@/lib/errors";
import { useComposerFileDrop } from "@/lib/fileDrop";
import { SECTION_BY_KEY, activeSection } from "@/lib/sections";
import { useChatAttachments } from "@/lib/stagedChatAttachments";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { AssistantMessageQueue, AssistantWorkStatus } from "@/components/chat/AssistantMessageQueue";
import { ChatAttachments } from "@/components/chat/ChatAttachments";
import {
  LiveTurnCard,
  shouldShowTurnSummary,
  TurnWorkSummary,
  useNow,
} from "@/components/chat/TurnActivity";
import { useFollowedTurn } from "@/components/chat/useFollowedTurn";
import { deriveLivePhase, describeLivePhase } from "@/lib/chatLiveness";
import type { FollowedTurnState } from "@/lib/followedTurn";
import {
  ResourceReferencePicker,
  insertResourceReference,
  resourceQueryAtCaret,
  useResourceReferences,
  type ChatResourceReference,
} from "@/components/chat/ResourceReferencePicker";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import {
  SidePanelResizeHandle,
  useSidePanelWidth,
  useWideViewport,
} from "@/components/ui/SidePanel";
import {
  APP_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT,
} from "@/components/ui/sidePanelWidth";
import { ButtonSpinner, Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  ASK_AI_KIND_LABELS,
  askAiContextKey,
  type AskAiContextRef,
} from "../../../shared/askAi";
import { useAskAi, type AskAiRequest } from "./AskAiProvider";
import { MailSuggestionButtons } from "./MailSuggestionButtons";

/**
 * Ask AI — the chat window behind the top nav's Ask AI button.
 *
 * Talk to any AI Employee, or several at once (`@a @b` — each answers in
 * turn). Whatever is on screen travels with the message: the panel shows it as
 * chips above the composer, the Member can drop any of them, and the server
 * shares each record with each employee only as far as that employee's Grants
 * allow — the chips say up front when someone will not be able to see one.
 *
 * Conversations are the Member's own and follow them around the product; every
 * message remembers the page it was sent from. Replies belong to the server,
 * so closing the panel or navigating mid-answer loses nothing.
 */

const WIDTH_STORAGE_KEY = "genosyn.askAi.width";
const ACTIVE_STORAGE_PREFIX = "genosyn.askAi.conversation.";
/** Composer preview refreshes this long after the page or exclusions settle. */
const PREVIEW_DELAY_MS = 150;
const NO_ANSWERS: AskAiMessage[] = [];

type Payload = Pick<AskAiSendInput, "page" | "refs" | "exclude"> & {
  /** Chips as they were when sent, for the optimistic bubble. */
  items: AskAiContextItem[];
};

function readActive(companyId: string): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_STORAGE_PREFIX + companyId);
  } catch {
    return null;
  }
}

function writeActive(companyId: string, id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_STORAGE_PREFIX + companyId, id);
    else window.localStorage.removeItem(ACTIVE_STORAGE_PREFIX + companyId);
  } catch {
    // Storage is a convenience; the panel falls back to the newest conversation.
  }
}

/** The conversation the panel reopens on: the one the Member left, else the newest. */
function reopenedId(companyId: string, conversations: AskAiConversation[]): string | null {
  const stored = readActive(companyId);
  return (conversations.find((c) => c.id === stored) ?? conversations[0])?.id ?? null;
}

export function AskAiPanel({ company }: { company: Company }) {
  const askAi = useAskAi();
  const location = useLocation();
  const dialog = useDialog();
  const { style, resizing, startResize, onResizeKeyDown } = useSidePanelWidth(WIDTH_STORAGE_KEY, {
    defaultWidth: 440,
    maxWidth: APP_PANEL_MAX_WIDTH,
  });
  const wide = useWideViewport(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT);
  const [conversations, setConversations] = React.useState<AskAiConversation[] | null>(null);
  const [roster, setRoster] = React.useState<AskAiRosterEntry[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [indexError, setIndexError] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  /** Counts the times the Member moved to a conversation here, to focus its box. */
  const [paneFocus, setPaneFocus] = React.useState(0);
  const creatingRef = React.useRef(false);
  /** Set while a request's new conversation is being opened, which the reopen waits for. */
  const openingRef = React.useRef(false);
  /** Conversations written in here, which the fetched list may not have titled yet. */
  const sentRef = React.useRef(new Set<string>());
  /** A request from elsewhere in the app, bound for the conversation it goes into. */
  const [handoff, setHandoff] = React.useState<{
    conversationId: string;
    request: AskAiRequest;
  } | null>(null);
  const pendingVersion = askAi?.pendingVersion ?? 0;
  const peekPending = askAi?.peekPending;
  const takePending = askAi?.takePending;

  const refreshIndex = React.useCallback(async () => {
    const result = await askAiApi.index(company.id);
    setConversations(result.conversations);
    setRoster(result.roster);
    return result;
  }, [company.id]);

  // Open on the conversation the Member left, else the newest, else a new one
  // — unless a waiting request wants a new conversation, which it opens below.
  React.useEffect(() => {
    let cancelled = false;
    setIndexError(null);
    void (async () => {
      try {
        const result = await refreshIndex();
        if (cancelled || openingRef.current || peekPending?.()?.newConversation) return;
        const pick = reopenedId(company.id, result.conversations);
        // Neither overrides a conversation a request opened meanwhile.
        if (pick) {
          setActiveId((current) => current ?? pick);
        } else if (!creatingRef.current) {
          creatingRef.current = true;
          try {
            const created = await askAiApi.create(company.id);
            if (cancelled) return;
            setConversations((list) => [created, ...(list ?? [])]);
            setActiveId((current) => current ?? created.id);
          } finally {
            creatingRef.current = false;
          }
        }
      } catch (err) {
        if (!cancelled) setIndexError(errorMessage(err, "Could not open Ask AI"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, refreshIndex, peekPending]);

  React.useEffect(() => {
    if (activeId) writeActive(company.id, activeId);
  }, [company.id, activeId]);

  /** Move to a conversation nobody has written in, creating one if none is waiting. */
  const openNew = React.useCallback(async (): Promise<string> => {
    const reuse = reusableConversationId(conversations ?? [], activeId, sentRef.current);
    if (reuse) {
      setActiveId(reuse);
      return reuse;
    }
    const created = await askAiApi.create(company.id);
    setConversations((list) => [created, ...(list ?? [])]);
    setActiveId(created.id);
    return created.id;
  }, [activeId, company.id, conversations]);

  const startNew = React.useCallback(async () => {
    setHistoryOpen(false);
    // Either way the next thing is typing the question.
    setPaneFocus((count) => count + 1);
    try {
      await openNew();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start a new conversation" });
    }
  }, [openNew, dialog]);

  // A request from elsewhere in the app ("Why did this Run fail?") goes into
  // the conversation on screen, or into a new one when it asks for that.
  React.useEffect(() => {
    if (!peekPending || !takePending || !conversations) return;
    const request = peekPending();
    if (!request) return;
    if (request.newConversation) {
      takePending();
      openingRef.current = true;
      openNew()
        .then(
          (conversationId) => setHandoff({ conversationId, request }),
          (err) => {
            // A panel that opened just for this still needs a conversation.
            const fallback = reopenedId(company.id, conversations);
            setActiveId((current) => current ?? fallback);
            if (activeId || fallback) {
              void dialog.error(err, { title: "Couldn’t start a new conversation" });
            } else {
              setIndexError(errorMessage(err, "Could not open Ask AI"));
            }
          },
        )
        .finally(() => {
          openingRef.current = false;
        });
    } else if (activeId) {
      takePending();
      setHandoff({ conversationId: activeId, request });
    }
  }, [
    pendingVersion,
    peekPending,
    takePending,
    conversations,
    activeId,
    openNew,
    dialog,
    company.id,
  ]);

  const takeHandoff = React.useCallback((request: AskAiRequest) => {
    setHandoff((current) => (current?.request === request ? null : current));
  }, []);

  const markSent = React.useCallback(
    (conversationId: string) => {
      sentRef.current.add(conversationId);
      // The server titles a conversation from its first message.
      window.setTimeout(() => void refreshIndex().catch(() => undefined), 1_500);
    },
    [refreshIndex],
  );

  const removeConversation = React.useCallback(
    async (id: string) => {
      try {
        await askAiApi.remove(company.id, id);
        const rest = (conversations ?? []).filter((c) => c.id !== id);
        setConversations(rest);
        if (id === activeId) {
          const next = rest[0];
          if (next) setActiveId(next.id);
          else {
            const created = await askAiApi.create(company.id);
            setConversations([created]);
            setActiveId(created.id);
          }
        }
      } catch (err) {
        void dialog.error(err, { title: "Couldn’t delete the conversation" });
      }
    },
    [activeId, company.id, conversations, dialog],
  );

  React.useEffect(() => {
    if (!askAi?.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (historyOpen) setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askAi?.open, historyOpen]);

  if (!askAi) return null;
  const sectionLabel = SECTION_BY_KEY[activeSection(location.pathname)]?.label ?? null;
  const shown = (conversations ?? []).filter((c) => c.title || c.id === activeId);

  return (
    <aside
      className={
        wide
          ? "relative flex h-full min-h-0 shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950" +
            (resizing ? "" : " transition-[width] duration-200")
          : "fixed inset-x-0 bottom-0 top-14 z-40 flex min-h-0 flex-col bg-white dark:bg-slate-950"
      }
      style={wide ? style : undefined}
      aria-label="Ask AI"
    >
      {wide && (
        <SidePanelResizeHandle
          label="Resize the Ask AI panel"
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
          active={resizing}
        />
      )}
      <div className="relative flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/15">
          <Sparkles size={14} className="text-violet-600 dark:text-violet-300" />
        </div>
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
          aria-expanded={historyOpen}
          aria-haspopup="menu"
          title="Conversations"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
              Ask AI
            </span>
            <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
              {shown.find((c) => c.id === activeId)?.title ?? "New conversation"}
            </span>
          </span>
          <ChevronDown size={14} className="ml-auto shrink-0 text-slate-400" />
        </button>
        <button
          type="button"
          onClick={() => void startNew()}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          title="New conversation"
          aria-label="New conversation"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          onClick={() => askAi.setOpen(false)}
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          title="Close"
          aria-label="Close Ask AI"
        >
          <X size={15} />
        </button>
        {historyOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setHistoryOpen(false)} />
            <div
              role="menu"
              className="absolute left-3 right-3 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="text-xs font-medium flex items-center gap-1.5 px-3 py-1.5 text-slate-500 dark:text-slate-400">
                <History size={11} /> Your conversations
              </div>
              {shown.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-500">Nothing here yet.</div>
              )}
              {shown.map((c) => (
                <div
                  key={c.id}
                  className={clsx(
                    "group flex items-center gap-2 px-3 py-1.5",
                    c.id === activeId
                      ? "bg-indigo-50 dark:bg-indigo-500/10"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800",
                  )}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActiveId(c.id);
                      setHistoryOpen(false);
                      setPaneFocus((count) => count + 1);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm text-slate-800 dark:text-slate-100">
                      {c.title ?? "New conversation"}
                    </span>
                    <span className="block text-[11px] text-slate-400">
                      {formatWhen(c.lastMessageAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeConversation(c.id)}
                    className="rounded p-1 text-slate-300 opacity-0 hover:bg-slate-100 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100 dark:hover:bg-slate-800"
                    title="Delete conversation"
                    aria-label={`Delete ${c.title ?? "conversation"}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {indexError ? (
        <div className="p-3">
          <FormError message={indexError} />
        </div>
      ) : !activeId ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : (
        <ConversationPane
          key={activeId}
          company={company}
          conversationId={activeId}
          initialRoster={roster}
          pageLabel={sectionLabel}
          focusKey={askAi.focusVersion + paneFocus}
          request={handoff?.conversationId === activeId ? handoff.request : null}
          onRequestTaken={takeHandoff}
          onSent={markSent}
        />
      )}
    </aside>
  );
}

function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** What travels with the next message: the records on screen, minus exclusions. */
function useContextPreview(companyId: string, refs: AskAiContextRef[], exclude: string[]) {
  const [preview, setPreview] = React.useState<AskAiContextPreview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const key = JSON.stringify([refs, exclude]);
  React.useEffect(() => {
    if (refs.length === 0) {
      setPreview({ items: [], defaultEmployeeIds: [], withheld: {} });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      askAiApi
        .preview(companyId, refs, exclude)
        .then((result) => {
          if (!cancelled) setPreview(result);
        })
        .catch(() => {
          // A failed preview just shows no chips; the server resolves the
          // context again on send regardless.
          if (!cancelled) setPreview({ items: [], defaultEmployeeIds: [], withheld: {} });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `key` carries refs + exclude by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, key]);
  return { preview, loading };
}

function ConversationPane({
  company,
  conversationId,
  initialRoster,
  pageLabel,
  focusKey,
  request,
  onRequestTaken,
  onSent,
}: {
  company: Company;
  conversationId: string;
  initialRoster: AskAiRosterEntry[];
  pageLabel: string | null;
  /**
   * Changes whenever the Member opens the panel, starts a conversation or
   * picks one, so the box takes focus then — and only then: a panel that
   * reopens itself after a reload leaves the page's focus alone.
   */
  focusKey: number;
  /** A request from elsewhere in the app for this conversation, until it is taken. */
  request: AskAiRequest | null;
  onRequestTaken: (request: AskAiRequest) => void;
  onSent: (conversationId: string) => void;
}) {
  const askAi = useAskAi();
  const navigate = useNavigate();
  const location = useLocation();
  const [draft, setDraft] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [excluded, setExcluded] = React.useState<string[]>([]);
  const [composerError, setComposerError] = React.useState<string | null>(null);
  const [targetMenuOpen, setTargetMenuOpen] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const refs = React.useMemo(() => askAi?.refs ?? [], [askAi?.refs]);
  // Exclusions belong to the page they were made on.
  React.useEffect(() => setExcluded([]), [location.pathname]);
  const { preview, loading: previewLoading } = useContextPreview(company.id, refs, excluded);

  const scopeKey = `askai:${company.id}:${conversationId}`;
  const adapter = React.useMemo(
    () => ({
      load: () =>
        askAiApi.load(company.id, conversationId).then((r) => ({
          messages: r.messages,
          roster: r.roster,
          modelId: r.modelId,
        })),
      send: (
        item: AssistantQueuedMessage,
        onEvent: (event: string, data: unknown) => void,
        signal: AbortSignal,
      ) => {
        const payload = item.payload as Payload | undefined;
        return askAiApi.send(
          company.id,
          conversationId,
          {
            message: item.message,
            employeeIds: item.employeeIds ?? [],
            attachmentIds: item.attachments.map((a) => a.id),
            modelId: item.modelId ?? null,
            page: payload?.page ?? { path: "/", label: null },
            refs: payload?.refs ?? [],
            exclude: payload?.exclude ?? [],
          },
          onEvent,
          { signal },
        );
      },
      clear: () => askAiApi.remove(company.id, conversationId),
      createUserMessage: (item: AssistantQueuedMessage): AskAiMessage => {
        const payload = item.payload as Payload | undefined;
        return {
          id: `temp-${item.id}`,
          conversationId,
          role: "user",
          turnId: null,
          employeeId: null,
          modelId: null,
          content: item.message,
          status: null,
          actions: [],
          suggestions: [],
          activity: null,
          attachments: item.attachments,
          context: payload
            ? { path: payload.page.path, pageLabel: payload.page.label, items: payload.items }
            : null,
          createdAt: item.queuedAt,
        };
      },
      initialTarget: (_bootstrap: AssistantChatBootstrap<AskAiMessage, AskAiRosterEntry>) => null,
    }),
    [company.id, conversationId],
  );
  const session = useAssistantChatSession(scopeKey, adapter);
  const {
    messages,
    loadError,
    streaming,
    streamOpen,
    reconnecting,
    modelId,
    setModelId,
    queuedMessages,
    queuePaused,
    updateMessage,
  } = session;
  const roster = session.roster.length > 0 ? session.roster : initialRoster;

  const attachmentDraft = useChatAttachments({
    scopeKey: `askai:${company.id}:${conversationId}`,
    upload: (file) => askAiApi.upload(company.id, file),
    onError: setComposerError,
  });
  const { pending, uploading, addFiles, clear: clearAttachments, isUploading } = attachmentDraft;

  // Mention + resource pickers.
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [resourceQuery, setResourceQuery] = React.useState<string | null>(null);
  const [resourceStart, setResourceStart] = React.useState<number | null>(null);
  const [resourceIndex, setResourceIndex] = React.useState(0);
  const { references, loading: referencesLoading } = useResourceReferences(
    company.id,
    resourceQuery,
  );

  // A request from elsewhere in the app ("Why did this run fail?").
  React.useEffect(() => {
    if (!request) return;
    onRequestTaken(request);
    if (request.prompt !== undefined) setDraft(request.prompt);
    if (request.employeeIds) setPicked(request.employeeIds);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [request, onRequestTaken]);

  React.useEffect(() => {
    if (focusKey <= 0) return;
    const frame = requestAnimationFrame(() => {
      // Opening Ask AI is a request to type in it, even from another box.
      focusOnArrival(textareaRef.current, { overTyping: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);

  const workingMessage = React.useMemo(
    () => (messages ?? []).find((m) => m.role === "assistant" && m.status === "working") ?? null,
    [messages],
  );

  // The answer being written, followed over its own stream: its steps, its
  // text, and what the AI Model is doing right now. A reload, a closed panel
  // or another tab picks the same answer up where it is.
  const workingId = workingMessage?.id ?? null;
  const followUrl = React.useMemo(
    () =>
      workingId
        ? (after: number) => askAiApi.activityStreamUrl(company.id, conversationId, workingId, after)
        : null,
    [company.id, conversationId, workingId],
  );
  const followed = useFollowedTurn({
    streamUrl: followUrl,
    turnId: workingId,
    startedAt: workingMessage ? Date.parse(workingMessage.createdAt) || null : null,
    onEnd: (event, data) => {
      // The finished answer, straight from the stream that watched it.
      if (event === "assistant" && isAnswer(data)) updateMessage(data);
    },
  });

  const [stopping, setStopping] = React.useState<string | null>(null);
  const [stopError, setStopError] = React.useState<{ id: string; message: string } | null>(null);
  React.useEffect(() => {
    // A stop lands when the answer finishes; whatever comes next starts fresh.
    if (stopping && stopping !== workingId) setStopping(null);
  }, [stopping, workingId]);
  const stopAnswer = React.useCallback(
    async (messageId: string) => {
      setStopping(messageId);
      setStopError(null);
      try {
        const result = await askAiApi.stop(company.id, conversationId, messageId);
        // One stopped here finishes in a moment and the stream brings it; one
        // that had nothing left running is final already.
        if (!result.stopped || result.message.status !== "working") {
          updateMessage(result.message);
          setStopping(null);
        }
      } catch (err) {
        setStopping(null);
        setStopError({ id: messageId, message: errorMessage(err, "Couldn’t stop this answer") });
      }
    },
    [company.id, conversationId, updateMessage],
  );

  // Follow the tail while the reader is at the bottom — new messages, the
  // live card growing, the answer streaming in — and leave them be once they
  // scroll up to read; "Jump to latest" brings them back.
  const stickToBottomRef = React.useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);
  const followTail = React.useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, followed.text, followed.live.events]);
  const transcriptObserver = React.useRef<ResizeObserver | null>(null);
  const transcriptRef = React.useCallback((content: HTMLDivElement | null) => {
    transcriptObserver.current?.disconnect();
    transcriptObserver.current = null;
    if (!content || typeof ResizeObserver === "undefined") return;
    transcriptObserver.current = new ResizeObserver(() => {
      const el = scrollerRef.current;
      if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    transcriptObserver.current.observe(content);
  }, []);
  const onTranscriptScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  };
  /** The answers to each message, in order — who an answer waits on, and who is next. */
  const answersByTurn = React.useMemo(() => {
    const byTurn = new Map<string, AskAiMessage[]>();
    for (const m of messages ?? []) {
      if (m.role !== "assistant" || !m.turnId) continue;
      const answers = byTurn.get(m.turnId) ?? [];
      answers.push(m);
      byTurn.set(m.turnId, answers);
    }
    return byTurn;
  }, [messages]);
  const owedCount = React.useMemo(
    () =>
      (messages ?? []).filter(
        (m) => m.role === "assistant" && (m.status === "working" || m.status === "queued"),
      ).length,
    [messages],
  );
  const turnInFlight = streamOpen || owedCount > 0 || reconnecting;
  const queueing = turnInFlight || queuedMessages.length > 0;
  const workingEmployee = roster.find((r) => r.id === workingMessage?.employeeId);

  const contextItems = React.useMemo(() => preview?.items ?? [], [preview]);
  // The record the page is about: the main item of the most specific ref, not
  // whatever related record (an invoice's customer) happens to be listed last.
  const focusItem = React.useMemo(() => {
    const lastRef = refs[refs.length - 1];
    return (
      (lastRef ? contextItems.find((item) => item.kind === lastRef.kind) : undefined) ??
      contextItems[0] ??
      null
    );
  }, [refs, contextItems]);
  const defaults = React.useMemo(() => preview?.defaultEmployeeIds ?? [], [preview]);
  const targets = React.useMemo(
    () => plannedTargets({ draft, roster, picked, messages, defaults }),
    [draft, roster, picked, messages, defaults],
  );
  const targetEntries = targets
    .map((id) => roster.find((r) => r.id === id))
    .filter((r): r is AskAiRosterEntry => Boolean(r));
  const single = targetEntries.length === 1 ? targetEntries[0] : null;
  const selectedModelId = React.useMemo(() => {
    const models = single?.models ?? [];
    if (models.length === 0) return null;
    if (modelId && models.some((m) => m.id === modelId)) return modelId;
    return models.find((m) => m.isActive)?.id ?? models[0].id;
  }, [single, modelId]);

  const withheldNotes = targetEntries
    .map((entry) => {
      const keys = preview?.withheld[entry.id] ?? [];
      const labels = contextItems
        .filter((item) => keys.includes(askAiContextKey(item)))
        .map((item) => item.label);
      return labels.length > 0 ? `${entry.name} can’t see ${labels.join(", ")}` : null;
    })
    .filter((note): note is string => Boolean(note));

  const send = React.useCallback(
    (text: string) => {
      const message = text.trim();
      if ((!message && pending.length === 0) || isUploading() || messages === null) return;
      setComposerError(null);
      const mentioned = mentionedRosterIds(message, roster);
      const employeeIds = mentioned.length > 0 ? [] : targets;
      const payload: Payload = {
        page: { path: location.pathname, label: pageLabel },
        refs,
        exclude: excluded,
        items: contextItems,
      };
      try {
        session.send({
          message,
          attachments: pending.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
          employeeIds,
          // The picker only applies when one employee answers.
          modelId: single ? selectedModelId : null,
          payload,
        });
      } catch (err) {
        setComposerError(errorMessage(err, "Could not queue this message"));
        return;
      }
      // Whoever this went to is who the conversation is with now.
      setPicked(mentioned.length > 0 ? mentioned : targets);
      setDraft("");
      clearAttachments();
      setMentionQuery(null);
      setResourceQuery(null);
      textareaRef.current?.focus();
      followTail();
      onSent(conversationId);
    },
    [
      pending,
      isUploading,
      messages,
      roster,
      targets,
      location.pathname,
      pageLabel,
      refs,
      excluded,
      contextItems,
      session,
      single,
      selectedModelId,
      clearAttachments,
      followTail,
      onSent,
      conversationId,
    ],
  );

  const { onPaste, dragProps } = useComposerFileDrop(addFiles, { disabled: messages === null });

  const retryFrom = React.useCallback(
    (failed: AskAiMessage) => {
      const list = messages ?? [];
      const asked = list.find((m) => m.id === failed.turnId && m.role === "user");
      if (!asked) return;
      const context = asked.context;
      try {
        setComposerError(null);
        session.retry({
          message: chatRetryText(asked),
          attachments: [],
          employeeIds: failed.employeeId ? [failed.employeeId] : [],
          modelId: failed.modelId,
          payload: {
            page: { path: context?.path ?? location.pathname, label: context?.pageLabel ?? null },
            // Ask about the same records again, by their canonical ids.
            refs: (context?.items ?? []).map((item) => ({ kind: item.kind, id: item.id })),
            exclude: [],
            items: context?.items ?? [],
          } satisfies Payload,
        });
      } catch (err) {
        setComposerError(errorMessage(err, "Could not retry this message"));
      }
    },
    [messages, session, location.pathname],
  );

  const mentionCandidates = React.useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return roster.filter((r) => r.slug.includes(q) || r.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mentionQuery, roster]);

  const refreshPickers = (value: string, caret: number) => {
    const resource = resourceQueryAtCaret(value, caret);
    setMentionQuery(mentionQueryAtCaret(value, caret));
    setResourceQuery(resource?.query ?? null);
    setResourceStart(resource?.start ?? null);
    setMentionIndex(0);
    setResourceIndex(0);
  };

  const pickMention = (entry: AskAiRosterEntry) => {
    const el = textareaRef.current;
    const next = insertMention(draft, el ? el.selectionStart : draft.length, entry.slug);
    setMentionQuery(null);
    if (!next) return;
    setDraft(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickReference = (reference: ChatResourceReference) => {
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (resourceQuery !== null && references.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setResourceIndex((i) => (i + step + references.length) % references.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickReference(references[resourceIndex] ?? references[0]);
        return;
      }
      if (e.key === "Escape") {
        setResourceQuery(null);
        return;
      }
    }
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((i) => (i + step + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionCandidates[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  };

  /**
   * Edit the addressees as shown, whichever rule produced them. While the
   * draft names people with `@`, those mentions are the list, so editing it
   * edits the draft.
   */
  const toggleTarget = (id: string) => {
    const entry = roster.find((r) => r.id === id);
    if (entry && mentionedRosterIds(draft, roster).length > 0) {
      if (targets.includes(id)) {
        const token = new RegExp(`(^|[\\s(])@${entry.slug}(?![a-z0-9-])\\s?`, "gi");
        setDraft((value) => value.replace(token, "$1"));
      } else {
        setDraft((value) => `${value.replace(/\s*$/, "")} @${entry.slug} `.trimStart());
      }
      return;
    }
    setPicked(
      targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id].slice(0, 5),
    );
  };

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          onScroll={onTranscriptScroll}
          className="h-full overflow-y-auto px-3 py-3"
        >
          <div ref={transcriptRef} className="space-y-4">
            {loadError && messages === null ? (
              <FormError message={loadError} />
            ) : messages === null ? (
              <div className="flex items-center justify-center py-16">
                <Spinner size={18} />
              </div>
            ) : messages.length === 0 && !streaming ? (
              <IntroTips
                company={company}
                roster={roster}
                focus={focusItem}
                onPick={(prompt) => {
                  setDraft(prompt);
                  textareaRef.current?.focus();
                }}
              />
            ) : (
              messages.map((m) => {
                const followedHere = m.id === workingId;
                return (
                  <MessageRow
                    key={m.id}
                    company={company}
                    message={m}
                    roster={roster}
                    streamingText={followedHere ? streaming : null}
                    reconnecting={followedHere && reconnecting}
                    followed={followedHere ? followed : null}
                    turnmates={(m.turnId && answersByTurn.get(m.turnId)) || NO_ANSWERS}
                    stopping={stopping === m.id}
                    stopError={stopError?.id === m.id ? stopError.message : null}
                    onStop={() => void stopAnswer(m.id)}
                    onRetry={retryFrom}
                    onExecuted={updateMessage}
                    compose={(init) => askAi?.compose(init) ?? false}
                    navigate={navigate}
                  />
                );
              })
            )}
          </div>
        </div>
        {showJumpToLatest && (
          <button
            type="button"
            onClick={followTail}
            className="absolute bottom-3 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <ArrowDown size={12} aria-hidden="true" />
            {workingMessage ? "Jump to the live answer" : "Jump to latest"}
          </button>
        )}
      </div>

      <div className="relative shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
        {turnInFlight && (
          <LiveWorkStatus
            name={workingEmployee?.name ?? "The AI Employee"}
            startedAt={workingMessage?.createdAt}
            reconnecting={reconnecting}
            followed={workingMessage ? followed : null}
            stopping={stopping !== null && stopping === workingId}
          />
        )}
        <AssistantMessageQueue
          messages={queuedMessages}
          paused={queuePaused}
          onRemove={session.removeQueuedMessage}
          onResume={session.resumeQueue}
        />

        <ContextChips
          items={contextItems}
          loading={previewLoading && contextItems.length === 0 && refs.length > 0}
          pageLabel={pageLabel}
          companySlug={company.slug}
          excludedCount={excluded.length}
          onExclude={(item) => setExcluded((list) => [...list, askAiContextKey(item)])}
          onRestore={() => setExcluded([])}
        />

        <div
          role="group"
          aria-label="Recipients"
          className="relative mb-2 flex flex-wrap items-center gap-1.5 text-[11px]"
        >
          <span className="text-slate-400">To</span>
          {targetEntries.length === 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              nobody yet — tag someone with @
            </span>
          )}
          {targetEntries.map((entry) => (
            <span
              key={entry.id}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pl-0.5 pr-1.5 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <Avatar
                name={entry.name}
                src={employeeAvatarUrl(company.id, entry.id, entry.avatarKey)}
                kind="ai"
                size="xs"
              />
              {entry.name}
              {!entry.hasModel && <span className="text-amber-600"> · no model</span>}
              {/* The only AI Employee who can answer has nobody to swap with. */}
              {soleAnswerer(roster) !== entry.id && (
                <button
                  type="button"
                  onClick={() => toggleTarget(entry.id)}
                  className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                  aria-label={`Remove ${entry.name}`}
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setTargetMenuOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400"
            aria-expanded={targetMenuOpen}
            aria-haspopup="menu"
          >
            <AtSign size={10} /> Add
          </button>
          {single && single.models.length > 1 && (
            <label className="ml-auto inline-flex items-center gap-1">
              <Brain size={11} aria-hidden="true" className="text-slate-400" />
              <span className="sr-only">AI Model for this message</span>
              <Select
                aria-label="AI Model for this message"
                value={selectedModelId ?? ""}
                onChange={(event) => setModelId(event.target.value)}
                className="max-w-40 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-medium text-slate-600 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                {single.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {askAiModelLabel(model)}
                    {model.isActive ? " (active)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {targetMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setTargetMenuOpen(false)} />
              <div
                role="menu"
                className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
              >
                {roster.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-500">
                    No AI Employees yet.{" "}
                    <Link
                      to={`/c/${company.slug}/employees/new`}
                      className="text-indigo-600 hover:underline"
                    >
                      Create one
                    </Link>
                  </div>
                )}
                {roster.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={targets.includes(entry.id)}
                    onClick={() => toggleTarget(entry.id)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Avatar
                      name={entry.name}
                      src={employeeAvatarUrl(company.id, entry.id, entry.avatarKey)}
                      kind="ai"
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900 dark:text-slate-100">
                        {entry.name}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        @{entry.slug}
                        {entry.hasModel ? ` · ${entry.role}` : " · no model connected"}
                      </span>
                    </span>
                    {targets.includes(entry.id) && (
                      <Check size={14} className="shrink-0 text-indigo-600" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {withheldNotes.length > 0 && (
          <p className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              {withheldNotes.join(". ")}. Their Grants don’t cover it, so it won’t be shared with
              them.
            </span>
          </p>
        )}

        {mentionQuery !== null && resourceQuery === null && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 z-10 mb-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            {mentionCandidates.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(r);
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
                    {r.hasModel ? ` · ${r.role}` : " · no model connected"}
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
            onPick={pickReference}
            className="absolute bottom-full left-3 right-3 z-10 mb-1"
          />
        )}
        <FormError message={composerError} />
        <ChatAttachments
          attachments={pending}
          urlFor={(id) => askAiApi.attachmentUrl(company.id, conversationId, id)}
          onRemove={attachmentDraft.remove}
        />
        <div
          {...dragProps}
          className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 focus-within:border-indigo-400 dark:border-slate-700 dark:bg-slate-900"
        >
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
            disabled={messages === null || uploading > 0}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            title="Attach a file"
            aria-label="Attach a file"
          >
            {uploading > 0 ? <Spinner size={12} /> : <Paperclip size={14} />}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={2}
            aria-label="Message"
            placeholder={
              turnInFlight
                ? "Add a follow-up — it sends after the current reply…"
                : focusItem
                  ? `Ask about ${focusItem.label}…`
                  : "Ask anything — @ to tag AI Employees, # to link a resource…"
            }
            onChange={(e) => {
              setDraft(e.target.value);
              refreshPickers(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => refreshPickers(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => {
              setMentionQuery(null);
              setResourceQuery(null);
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <button
            type="button"
            onClick={() => send(draft)}
            disabled={(!draft.trim() && pending.length === 0) || messages === null || uploading > 0}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white transition-opacity hover:bg-indigo-500 disabled:opacity-40"
            aria-label={queueing ? "Queue message" : "Send message"}
            title={queueing ? "Queue message (Enter)" : "Send (Enter)"}
          >
            {queueing ? <Clock size={14} /> : <Send size={14} />}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
          <span className="font-mono">@</span> AI Employees (tag several) ·{" "}
          <span className="font-mono">#</span> resource · Shift+Enter for a new line
        </div>
      </div>
    </>
  );
}

function ContextChips({
  items,
  loading,
  pageLabel,
  companySlug,
  excludedCount,
  onExclude,
  onRestore,
}: {
  items: AskAiContextItem[];
  loading: boolean;
  pageLabel: string | null;
  companySlug: string;
  excludedCount: number;
  onExclude: (item: AskAiContextItem) => void;
  onRestore: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="Page context">
      <span className="text-slate-400">Context</span>
      {loading ? (
        <Spinner size={10} />
      ) : items.length === 0 ? (
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {pageLabel ? `${pageLabel} page` : "This page"}
        </span>
      ) : (
        items.map((item) => (
          <span
            key={askAiContextKey(item)}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-violet-200 bg-violet-50 py-0.5 pl-2 pr-1 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200"
            title={item.sublabel ? `${item.label} — ${item.sublabel}` : item.label}
          >
            <FileText size={10} className="shrink-0" />
            {item.href ? (
              <Link to={`/c/${companySlug}${item.href}`} className="max-w-[12rem] truncate hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="max-w-[12rem] truncate">{item.label}</span>
            )}
            <button
              type="button"
              onClick={() => onExclude(item)}
              className="rounded-full p-0.5 text-violet-400 hover:bg-violet-100 hover:text-violet-700 dark:hover:bg-violet-500/20"
              aria-label={`Don’t include ${item.label}`}
              title="Don’t include this in the next message"
            >
              <X size={10} />
            </button>
          </span>
        ))
      )}
      {excludedCount > 0 && (
        <button
          type="button"
          onClick={onRestore}
          className="text-slate-400 underline-offset-2 hover:text-indigo-600 hover:underline"
        >
          Restore {excludedCount} removed
        </button>
      )}
    </div>
  );
}

function IntroTips({
  company,
  roster,
  focus,
  onPick,
}: {
  company: Company;
  roster: AskAiRosterEntry[];
  focus: AskAiContextItem | null;
  onPick: (prompt: string) => void;
}) {
  const prompts = focus
    ? [
        `Summarize this ${ASK_AI_KIND_LABELS[focus.kind].toLowerCase()} for me.`,
        "What needs my attention here, and what would you do next?",
        "Is anything here wrong, missing, or at risk?",
      ]
    : [
        "What should I be paying attention to today?",
        "What did the team get done this week?",
      ];
  const available = roster.filter((r) => r.hasModel);
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <Bot size={15} className="text-violet-500" /> Ask your AI Employees
      </div>
      <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        What you have open comes along with your message — the chips above the box show what. Tag
        one AI Employee with <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">@</code>,
        or several to hear from each of them. Each one only sees what its Grants allow.
      </p>
      {available.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {available.slice(0, 6).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPick(`@${r.slug} `)}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 py-0.5 pl-0.5 pr-2 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300"
            >
              <Avatar
                name={r.name}
                src={employeeAvatarUrl(company.id, r.id, r.avatarKey)}
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
            type="button"
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

function MessageRow({
  company,
  message,
  roster,
  streamingText,
  reconnecting,
  followed,
  turnmates,
  stopping,
  stopError,
  onStop,
  onRetry,
  onExecuted,
  compose,
  navigate,
}: {
  company: Company;
  message: AskAiMessage;
  roster: AskAiRosterEntry[];
  streamingText: string | null;
  reconnecting: boolean;
  /** The answer being written, as its own stream tells it; null on every other row. */
  followed: FollowedTurnState | null;
  /** Every answer to the same message, this one included, in order. */
  turnmates: AskAiMessage[];
  stopping: boolean;
  stopError: string | null;
  onStop: () => void;
  onRetry: (message: AskAiMessage) => void;
  onExecuted: (message: AskAiMessage) => void;
  compose: Parameters<typeof MailSuggestionButtons>[0]["compose"];
  navigate: (to: string) => void;
}) {
  const attachmentUrl = (id: string) =>
    askAiApi.attachmentUrl(company.id, message.conversationId, id);

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] break-words rounded-2xl rounded-tr-md bg-indigo-600 px-3.5 py-2 text-sm text-white [&_a]:text-white [&_a]:underline">
          <ChatMarkdown content={message.content} />
        </div>
        {message.attachments.length > 0 && (
          <AttachmentChips attachments={message.attachments} urlFor={attachmentUrl} align="end" />
        )}
        {message.context && message.context.items.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1 text-[10px] text-slate-400">
            {message.context.items.map((item) => (
              <span key={askAiContextKey(item)} className="inline-flex items-center gap-0.5">
                <FileText size={9} />
                {item.href ? (
                  <Link to={`/c/${company.slug}${item.href}`} className="hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const emp = message.employeeId ? roster.find((r) => r.id === message.employeeId) : undefined;
  const isError = message.status === "error";
  const isSkipped = message.status === "skipped";
  const isWorking = message.status === "working";
  const isQueued = message.status === "queued";
  const isInterrupted = message.status === "interrupted";
  const untargetedNotice = isError && !message.employeeId;
  const canRetry =
    (isError || isSkipped || isInterrupted) && !untargetedNotice && Boolean(message.turnId);
  const name = emp?.name ?? (untargetedNotice ? "Ask AI" : "The AI Employee");
  const nameOf = (m: AskAiMessage | undefined) =>
    m ? (roster.find((r) => r.id === m.employeeId)?.name ?? "The AI Employee") : null;
  const index = turnmates.findIndex((m) => m.id === message.id);
  // Who this answer waits on, and who answers after it, among the employees asked together.
  const before = index > 0 ? turnmates.slice(0, index).find((m) => m.status === "working") : undefined;
  const after = turnmates.slice(index + 1).find((m) => m.status === "queued");

  const avatar = emp ? (
    <Avatar
      name={emp.name}
      src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
      kind="ai"
      size="md"
    />
  ) : (
    <div
      className={clsx(
        "flex h-8 w-8 items-center justify-center rounded-full",
        isError ? "bg-rose-100 dark:bg-rose-500/15" : "bg-violet-100 dark:bg-violet-500/15",
      )}
    >
      {isError ? (
        <AlertTriangle size={14} className="text-rose-600 dark:text-rose-300" />
      ) : (
        <Bot size={14} className="text-violet-600 dark:text-violet-300" />
      )}
    </div>
  );

  if (isWorking && followed) {
    return (
      <LiveTurnCard
        authorName={name}
        avatar={avatar}
        live={followed.live}
        streamingReply={followed.text || streamingText || message.content || null}
        progress={followed.progress}
        connectionState={
          reconnecting && followed.connection !== "streaming" ? "reconnecting" : followed.connection
        }
        stopping={stopping}
        onStop={onStop}
        companySlug={company.slug}
        context={after ? `${nameOf(after)} answers next` : null}
        stopError={stopError}
      />
    );
  }

  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-medium text-slate-700 dark:text-slate-200">{name}</span>
          {isQueued && (
            <Badge tone="neutral" icon={<Clock />}>
              Waiting
            </Badge>
          )}
          {isWorking && (
            <Badge tone="accent" icon={<ButtonSpinner size={10} />}>
              {reconnecting ? "Reconnecting" : "Working"}
            </Badge>
          )}
          {isInterrupted && (
            <Badge tone="neutral" icon={<CircleSlash />}>
              Stopped
            </Badge>
          )}
          {isSkipped && (
            <Badge tone="warning" icon={<CircleSlash />}>
              Skipped
            </Badge>
          )}
          {isError && !untargetedNotice && (
            <Badge tone="danger" icon={<AlertTriangle />}>
              Error
            </Badge>
          )}
        </div>
        {shouldShowTurnSummary(message.activity) && message.activity && (
          <TurnWorkSummary
            summary={message.activity}
            activityUrl={askAiApi.activityUrl(company.id, message.conversationId, message.id)}
            messageId={message.id}
            companySlug={company.slug}
          />
        )}
        <div
          className={clsx(
            "rounded-2xl rounded-tl-md px-3.5 py-2 text-sm leading-relaxed shadow-sm",
            isError
              ? "border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
              : isSkipped
                ? "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                : isQueued || isWorking
                  ? "border border-slate-200 bg-slate-50 text-slate-500 shadow-none dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400"
                  : isInterrupted
                    ? "border border-dashed border-slate-300 bg-white text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
          )}
        >
          {isQueued ? (
            <div className="flex items-center gap-2 text-xs">
              <Clock size={12} aria-hidden="true" className="shrink-0" />
              {before
                ? `Answers once ${nameOf(before)} has finished.`
                : "Answers after the AI Employee before them."}
            </div>
          ) : isWorking ? (
            <div className="flex items-center gap-2 text-xs">
              <Spinner size={12} />
              {`${name} is working on this, and the answer will appear here.`}
            </div>
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
            type="button"
            onClick={() => onRetry(message)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300"
          >
            <RotateCcw size={11} /> {isInterrupted ? "Ask again" : "Try again"}
          </button>
        )}
        {message.actions.length > 0 && <ActionPills actions={message.actions} />}
        {message.suggestions.length > 0 && (
          <MailSuggestionButtons
            company={company}
            message={message}
            compose={compose}
            navigate={navigate}
            onExecuted={onExecuted}
          />
        )}
      </div>
    </div>
  );
}

/** A finished answer as the follow stream hands it over. */
function isAnswer(value: unknown): value is AskAiMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AskAiMessage>;
  return typeof row.id === "string" && row.role === "assistant" && typeof row.status === "string";
}

/**
 * The line beside the composer while an answer is written: who, what they are
 * doing this moment, and for how long — still in view when the Member has
 * scrolled up the conversation.
 */
function LiveWorkStatus({
  name,
  startedAt,
  reconnecting,
  followed,
  stopping,
}: {
  name: string;
  startedAt?: string;
  reconnecting: boolean;
  followed: FollowedTurnState | null;
  stopping: boolean;
}) {
  const clientNow = useNow(Boolean(followed));
  let doing: string | null = null;
  if (followed) {
    const now = clientNow + followed.live.clockOffsetMs;
    const phase = deriveLivePhase({
      events: followed.live.events,
      startedAt: followed.live.startedAt ?? (startedAt ? Date.parse(startedAt) : now),
      now,
      lastTextAt: followed.live.lastTextAt,
      lastSignalAt: followed.live.lastSignalAt,
      connection: reconnecting ? "reconnecting" : followed.connection,
      stopping,
      hasReplyText: Boolean(followed.text),
      pulse: followed.live.pulse,
    });
    doing = describeLivePhase(phase, name, now).title;
  }
  return (
    <AssistantWorkStatus name={name} startedAt={startedAt} reconnecting={reconnecting} doing={doing} />
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChips({
  attachments,
  urlFor,
  align,
}: {
  attachments: AskAiMessage["attachments"];
  urlFor: (id: string) => string;
  align: "start" | "end";
}) {
  return (
    <div className={clsx("mt-1.5 flex flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
      {attachments.map((a) => (
        <a
          key={a.id}
          href={urlFor(a.id)}
          download={a.filename}
          title={`Download ${a.filename}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
        >
          <FileText size={11} className="shrink-0 text-slate-400" />
          <span className="max-w-[180px] truncate">{a.filename}</span>
          <span className="shrink-0 text-slate-400">{formatBytes(a.sizeBytes)}</span>
        </a>
      ))}
    </div>
  );
}

function ActionPills({ actions }: { actions: MessageAction[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {actions.map((a, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
          title={a.targetLabel || a.action}
        >
          <Check size={10} className="text-emerald-500" />
          <span className="max-w-[180px] truncate">
            {a.action}
            {a.targetLabel ? ` "${a.targetLabel}"` : ""}
          </span>
        </span>
      ))}
    </div>
  );
}
