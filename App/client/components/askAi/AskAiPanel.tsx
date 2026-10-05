import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  AtSign,
  Bot,
  Brain,
  Check,
  ChevronDown,
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
import {
  askAiApi,
  askAiModelLabel,
  insertMention,
  mentionQueryAtCaret,
  mentionedRosterIds,
  plannedTargets,
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
  ResourceReferencePicker,
  insertResourceReference,
  resourceQueryAtCaret,
  useResourceReferences,
  type ChatResourceReference,
} from "@/components/chat/ResourceReferencePicker";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { useDialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/FormError";
import { Select } from "@/components/ui/Select";
import {
  SidePanelResizeHandle,
  useSidePanelWidth,
  useWideViewport,
} from "@/components/ui/SidePanel";
import { SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT } from "@/components/ui/sidePanelWidth";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  ASK_AI_KIND_LABELS,
  askAiContextKey,
  type AskAiContextRef,
} from "../../../shared/askAi";
import { useAskAi } from "./AskAiProvider";
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

export function AskAiPanel({ company }: { company: Company }) {
  const askAi = useAskAi();
  const location = useLocation();
  const dialog = useDialog();
  const { width, resizing, startResize, onResizeKeyDown } = useSidePanelWidth(
    WIDTH_STORAGE_KEY,
    440,
  );
  const wide = useWideViewport(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT);
  const [conversations, setConversations] = React.useState<AskAiConversation[] | null>(null);
  const [roster, setRoster] = React.useState<AskAiRosterEntry[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [indexError, setIndexError] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const creatingRef = React.useRef(false);

  const refreshIndex = React.useCallback(async () => {
    const result = await askAiApi.index(company.id);
    setConversations(result.conversations);
    setRoster(result.roster);
    return result;
  }, [company.id]);

  // Open on the conversation the Member left, else the newest, else a new one.
  React.useEffect(() => {
    let cancelled = false;
    setIndexError(null);
    void (async () => {
      try {
        const result = await refreshIndex();
        if (cancelled) return;
        const stored = readActive(company.id);
        const pick =
          result.conversations.find((c) => c.id === stored) ?? result.conversations[0] ?? null;
        if (pick) {
          setActiveId(pick.id);
        } else if (!creatingRef.current) {
          creatingRef.current = true;
          try {
            const created = await askAiApi.create(company.id);
            if (cancelled) return;
            setConversations([created]);
            setActiveId(created.id);
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
  }, [company.id, refreshIndex]);

  React.useEffect(() => {
    if (activeId) writeActive(company.id, activeId);
  }, [company.id, activeId]);

  const startNew = React.useCallback(async () => {
    setHistoryOpen(false);
    const current = conversations?.find((c) => c.id === activeId);
    // An untouched conversation is already "new"; don't stack empty ones.
    if (current && !current.title) return;
    try {
      const created = await askAiApi.create(company.id);
      setConversations((list) => [created, ...(list ?? [])]);
      setActiveId(created.id);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t start a new conversation" });
    }
  }, [activeId, company.id, conversations, dialog]);

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
      style={wide ? { width } : undefined}
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
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900"
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
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
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
          onSent={() => void refreshIndex().catch(() => undefined)}
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
  onSent,
}: {
  company: Company;
  conversationId: string;
  initialRoster: AskAiRosterEntry[];
  pageLabel: string | null;
  onSent: () => void;
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
  const pendingVersion = askAi?.pendingVersion ?? 0;
  const takePending = askAi?.takePending;
  React.useEffect(() => {
    if (!takePending) return;
    const request = takePending();
    if (!request) return;
    if (request.prompt !== undefined) setDraft(request.prompt);
    if (request.employeeIds) setPicked(request.employeeIds);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [pendingVersion, takePending]);

  React.useEffect(() => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [messages?.length, streaming]);

  const workingMessage = React.useMemo(
    () => (messages ?? []).find((m) => m.role === "assistant" && m.status === "working") ?? null,
    [messages],
  );
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
      window.setTimeout(onSent, 1_500);
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
      onSent,
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
      <div ref={scrollerRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {loadError && messages === null ? (
          <FormError message={loadError} />
        ) : messages === null ? (
          <div className="flex h-full items-center justify-center">
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
          messages.map((m) => (
            <MessageRow
              key={m.id}
              company={company}
              message={m}
              roster={roster}
              streamingText={m.id === workingMessage?.id ? streaming : null}
              reconnecting={m.id === workingMessage?.id && reconnecting}
              onRetry={retryFrom}
              onExecuted={session.updateMessage}
              compose={(init) => askAi?.compose(init) ?? false}
              navigate={navigate}
            />
          ))
        )}
      </div>

      <div className="relative shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
        {turnInFlight && (
          <AssistantWorkStatus
            name={workingEmployee?.name ?? "The AI Employee"}
            startedAt={workingMessage?.createdAt}
            reconnecting={reconnecting}
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

        <div className="relative mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
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
              <button
                type="button"
                onClick={() => toggleTarget(entry.id)}
                className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                aria-label={`Remove ${entry.name}`}
              >
                <X size={10} />
              </button>
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
                className="max-w-40 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
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
        <div className="max-w-[85%] break-words rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white [&_a]:text-white [&_a]:underline">
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
  const untargetedNotice = isError && !message.employeeId;
  const canRetry = (isError || isSkipped) && !untargetedNotice && Boolean(message.turnId);

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
          {emp?.name ?? "Ask AI"}
          {isSkipped ? " · skipped" : ""}
          {isQueued ? " · waiting" : ""}
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
          {isQueued ? (
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <Clock size={12} /> Answers after the AI Employee before them.
            </div>
          ) : isWorking ? (
            <WorkingBody
              name={emp?.name ?? "The AI Employee"}
              text={streamingText ?? (message.content || null)}
              reconnecting={reconnecting}
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
            type="button"
            onClick={() => onRetry(message)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-300"
          >
            <RotateCcw size={11} /> Try again
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
        <div className="mt-2 flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-300">
          <Spinner size={12} />
          {reconnecting ? "Reconnecting…" : "Still working…"}
        </div>
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
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
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
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
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
