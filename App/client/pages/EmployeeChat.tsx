import React from "react";
import { Select } from "@/components/ui/Select";
import { Link, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  Download,
  Gauge,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  Plug,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  api,
  AIModel,
  ChatAttachment,
  ChatContextUsage,
  Company,
  ConversationMessage,
  ConversationSummary,
  Employee,
  MessageAction,
} from "../lib/api";
import { describeContextUsage } from "../lib/chatContextUsage";
import { isIndeterminateChatProgress, shouldShowChatProgressCard } from "../lib/chatProgress";
import {
  type EmployeeSession,
  QueuedChatMessage,
  shouldRenderQueuedMessage,
  useEmployeeSession,
} from "../lib/chatSessions";
import { type ComposerModelOverride, resolveComposerModelId } from "../lib/composerModel";
import { useComposerFileDrop } from "../lib/fileDrop";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { EmployeeHeader } from "../components/EmployeeHeader";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { BrowserLivePanel } from "../components/BrowserLivePanel";
import {
  RepositoryWorkPanel,
  WORK_PANEL_MIN_SIDE_BY_SIDE,
} from "../components/RepositoryWorkPanel";
import { useWideViewport } from "../components/ui/SidePanel";
import {
  collectTranscriptWorkTargets,
  parseRepositoryWorkHref,
  shouldOpenWorkLinkInPanel,
} from "../lib/repositoryWorkLink";
import {
  initialRepositoryWorkPanelState,
  repositoryWorkPanelReducer,
} from "../lib/repositoryWorkPanel";
import { ChatBrowserTarget } from "../components/ChatBrowserTarget";
import {
  ChatResourceReference,
  insertResourceReference,
  ResourceReferencePicker,
  resourceQueryAtCaret,
  useResourceReferences,
} from "../components/chat/ResourceReferencePicker";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * Chat with the selected employee. Threads are persisted server-side; the
 * left rail lists them newest-first and the main panel shows the selected
 * thread. Durable state (messages, the in-flight streaming reply, the typed
 * input, the selected thread) lives in `ChatSessionsProvider` so navigating
 * to another page mid-conversation and returning keeps the turn intact.
 */

export default function EmployeeChat() {
  const { company, currentUserId, emp } = useOutletContext<EmployeeOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const location = useLocation();
  const navigate = useNavigate();
  const { session, actions } = useEmployeeSession(emp.id);
  const {
    activeConvId,
    loadedConvId,
    messages,
    streamingReply,
    progress,
    contextUsage,
    connectionState,
    sendingConvId,
    sendingNewConversationIntent,
    sending,
    queuedMessages,
    newConversationIntent,
    input,
    convs,
    convsLoaded,
    convLoading,
  } = session;

  /** Action whose details are open in the logs modal; null when closed. */
  const [inspectAction, setInspectAction] = React.useState<MessageAction | null>(null);
  /** Files staged for the next send. Stored on the page so the chips persist
   * if the textarea remounts and so we can clear them after a successful
   * send / when switching conversations. */
  const [pendingAttachments, setPendingAttachments] = React.useState<ChatAttachment[]>([]);
  const [chatModels, setChatModels] = React.useState<AIModel[]>([]);
  /**
   * Model the human picked by hand, scoped to the thread they picked it on.
   * Switching threads drops it so the new thread's own model takes over again,
   * and a thread created lazily by the first send inherits its persisted choice
   * rather than an override keyed to the not-yet-existing conversation.
   */
  const [modelOverride, setModelOverride] = React.useState<ComposerModelOverride | null>(null);
  const [claimingLegacy, setClaimingLegacy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is parked at the bottom of the thread. A long reply
   * arrives as dozens of chunks, so following the tail unconditionally yanks
   * the viewport away from anyone who scrolled up to re-read something.
   */
  const stickToBottomRef = React.useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const seededPrompt = React.useRef<string | null>(null);
  const visibleQueuedMessages = queuedMessages.filter((message) =>
    shouldRenderQueuedMessage(
      message.conversationId,
      activeConvId,
      message.newConversationIntent,
      newConversationIntent,
    ),
  );
  const isActiveResponse =
    sending &&
    sendingConvId === activeConvId &&
    (sendingConvId !== null || sendingNewConversationIntent === newConversationIntent);
  const hasStreamingReply = streamingReply !== null && streamingReply.length > 0;
  const hasProgressCard = progress
    ? shouldShowChatProgressCard(progress.percent, progress.label, connectionState)
    : false;
  const showTypingIndicator =
    isActiveResponse && !hasStreamingReply && (!progress || !hasProgressCard);
  const showProgressIndicator =
    isActiveResponse && !hasStreamingReply && Boolean(progress) && hasProgressCard;
  const visibleMessages = messages.filter((message) => message.status !== "working");

  /**
   * Repository work the employee has linked in this thread.
   *
   * Derived from the stored messages rather than the render-time list so a
   * streaming reply, which repaints this component on every chunk, doesn't
   * re-scan the transcript dozens of times a second — but filtered the same
   * way the transcript is, so the panel never opens onto something the reader
   * cannot see the link for.
   */
  const workTargets = React.useMemo(
    () =>
      collectTranscriptWorkTargets(
        messages.filter((message) => message.status !== "working").map((m) => m.content),
        company.slug,
        window.location.origin,
      ),
    [messages, company.slug],
  );
  const [workPanel, dispatchWorkPanel] = React.useReducer(
    repositoryWorkPanelReducer,
    initialRepositoryWorkPanelState,
  );
  /** Whether the panel would sit beside the thread rather than cover it. */
  const canDockWorkPanel = useWideViewport(WORK_PANEL_MIN_SIDE_BY_SIDE);
  /**
   * The thread whose history has already been taken in, so later links are
   * news. Undefined rather than null to start: null is a real value here — a
   * thread that has not been created yet — and it must not read as "already
   * loaded" on the first pass.
   */
  const hydratedConvId = React.useRef<string | null | undefined>(undefined);

  /**
   * A work-session link opens the session beside the thread instead of
   * replacing it. Delegated from the transcript because the reply is rendered
   * markdown — there is no component to hang an onClick on — and because it
   * then also covers a link a Member pasted in themselves.
   */
  const openWorkFromLink = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const node = event.target as Element | null;
      const anchor = node?.closest?.("a");
      if (!anchor) return;
      const intercept = shouldOpenWorkLinkInPanel({
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        anchorTarget: anchor.getAttribute("target"),
      });
      if (!intercept) return;
      const target = parseRepositoryWorkHref(
        anchor.getAttribute("href"),
        company.slug,
        window.location.origin,
      );
      if (!target) return;
      event.preventDefault();
      dispatchWorkPanel({ type: "open", target });
    },
    [company.slug],
  );

  // Onboarding and other guided surfaces can hand chat a draft without
  // sending it. The Member still reviews and submits the message, so opening
  // the page never spends model tokens or takes an action by itself. Router
  // state keeps the draft out of the URL and browser/server logs.
  React.useEffect(() => {
    const state = location.state as { starterPrompt?: unknown } | null;
    const prompt = typeof state?.starterPrompt === "string" ? state.starterPrompt.trim() : "";
    if (!prompt) {
      seededPrompt.current = null;
      return;
    }
    if (seededPrompt.current === prompt) return;
    seededPrompt.current = prompt;
    actions.update(emp.id, (current) =>
      current.input.trim() ? current : { ...current, input: prompt },
    );
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [actions, emp.id, location.pathname, location.search, location.state, navigate]);

  // `?conversation=<id>` opens a specific thread. The Decision Stack links here
  // when an employee stacked its question mid-chat, and landing on whatever
  // thread happened to be selected would be worse than not linking at all. The
  // param is consumed once and stripped, so the back button and a later manual
  // thread switch don't fight each other over the selection.
  React.useEffect(() => {
    const wanted = new URLSearchParams(location.search).get("conversation");
    if (!wanted) return;
    const params = new URLSearchParams(location.search);
    params.delete("conversation");
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}`, { replace: true });
    actions
      .selectConversation(company.id, emp.id, wanted)
      .catch((err) => toast((err as Error).message, "error"));
    // `toast` is stable for the life of the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, company.id, emp.id, location.pathname, location.search, navigate]);

  // Reset staged attachments when the active conversation changes — leaving
  // them around would attach to the wrong thread on the next send.
  React.useEffect(() => {
    setPendingAttachments([]);
  }, [activeConvId]);

  // A newly opened thread starts pinned to its newest message, whatever the
  // reader was doing in the thread they just left.
  React.useEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [activeConvId]);

  // Fetch the conversation list for this employee the first time we mount.
  // `initEmployee` is a no-op once `convsLoaded` is true, so coming back to
  // this tab keeps whatever the user had selected.
  React.useEffect(() => {
    actions.initEmployee(company.id, emp.id).catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  // The dedicated employee chat can override the active model per message.
  // Only connected models can answer, so they're the only ones offered.
  React.useEffect(() => {
    let cancelled = false;
    api
      .get<AIModel[]>(`/api/companies/${company.id}/employees/${emp.id}/models`)
      .then((models) => {
        if (cancelled) return;
        setChatModels(models.filter((model) => model.status === "connected"));
      })
      .catch(() => {
        if (cancelled) return;
        setChatModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, emp.id]);

  // Load the selected conversation's messages whenever the pointer drifts
  // from what's loaded. Skipped if we already hold the messages for it.
  React.useEffect(() => {
    if (!activeConvId) return;
    if (loadedConvId === activeConvId) return;
    actions
      .selectConversation(company.id, emp.id, activeConvId)
      .catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, loadedConvId, emp.id]);

  // A durable working message can outlive the original response stream or a
  // full page load. While this browser is not receiving the live stream,
  // refresh the thread every few seconds so persisted milestones and the final
  // reply appear automatically.
  React.useEffect(() => {
    if (!activeConvId || !isActiveResponse) return;
    if (connectionState === "streaming") return;
    let stopped = false;
    const refresh = () => {
      if (stopped) return;
      actions.refreshConversation(company.id, emp.id, activeConvId).catch(() => {
        // The progress card already says that reconnection is in progress.
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [actions, activeConvId, company.id, connectionState, emp.id, isActiveResponse]);

  // Follow the tail on new messages and while the reply streams in — but only
  // while the reader is still at the bottom. Scrolling up is how someone reads
  // the earlier part of a long answer, and dragging them back down on every
  // streamed chunk makes that impossible. `useLayoutEffect` scrolls before
  // paint so the follow never shows as a visible jump.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isActiveResponse, streamingReply, progress, visibleQueuedMessages.length]);

  /** Re-attach to the tail: used by the jump button and by sending a message. */
  function followTail() {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // A scroll that leaves the bottom detaches the view; coming back re-attaches
  // it. The threshold absorbs sub-pixel rounding and the last chunk of a reply
  // landing between the event and the render.
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }

  // Auto-grow the textarea as the user types, capped so it doesn't swallow
  // the conversation.
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  async function handleNewClick() {
    try {
      await actions.newConversation(company.id, emp.id);
      inputRef.current?.focus();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleDelete(convId: string) {
    const ok = await dialog.confirm({
      title: "Delete conversation?",
      message: "Every message in this thread will be permanently removed.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await actions.deleteConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleArchive(convId: string) {
    try {
      await actions.archiveConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleUnarchive(convId: string) {
    try {
      await actions.unarchiveConversation(company.id, emp.id, convId);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function handleClaimLegacyConversation() {
    if (!activeConvId || claimingLegacy) return;
    setClaimingLegacy(true);
    try {
      await actions.claimConversation(company.id, emp.id, activeConvId);
      await actions.refreshConversation(company.id, emp.id, activeConvId);
      toast("Conversation claimed. You can continue it privately.", "success");
      inputRef.current?.focus();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setClaimingLegacy(false);
    }
  }

  async function send(messageOverride?: string) {
    if (activeConv?.legacyUnclaimed) {
      toast("Claim this legacy conversation before continuing it.", "error");
      return;
    }
    const msg = (messageOverride ?? input).trim();
    const atts = messageOverride ? [] : pendingAttachments;
    // Slash commands intercept the send. `/new` swaps to a fresh thread
    // without sending the slash itself as a message — same effect as
    // clicking the "New conversation" button but reachable from the
    // keyboard alone.
    if (!messageOverride && msg === "/new" && atts.length === 0) {
      actions.update(emp.id, { input: "" });
      try {
        await actions.newConversation(company.id, emp.id);
      } catch (err) {
        toast((err as Error).message, "error");
      }
      inputRef.current?.focus();
      return;
    }
    if (!msg && atts.length === 0) return;
    if (!messageOverride) setPendingAttachments([]);
    // Sending is an explicit "show me what happens next".
    followTail();
    const err = await actions.send(company.id, emp.id, msg, {
      clearInput: !messageOverride,
      attachments: atts,
      modelId: selectedModelId,
    });
    if (err) {
      toast(err, "error");
      // Restore the chips so the human can retry without re-uploading.
      if (!messageOverride) setPendingAttachments(atts);
    }
    inputRef.current?.focus();
  }

  async function uploadAttachment(file: File): Promise<void> {
    try {
      const a = await api.uploadFile<ChatAttachment>(
        `/api/companies/${company.id}/employees/${emp.id}/chat-attachments`,
        file,
      );
      setPendingAttachments((prev) => [...prev, a]);
    } catch (err) {
      toast(`Upload failed: ${(err as Error).message}`, "error");
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const activeConv =
    convs.find((c) => c.id === activeConvId) ??
    session.archivedConvs.find((c) => c.id === activeConvId) ??
    null;
  // Reopening a past thread must keep the brain it was held with — the server
  // reports each thread's last model on the summary. See `composerModel.ts`
  // for the full precedence rule.
  const selectedModelId = resolveComposerModelId({
    models: chatModels,
    activeConvId,
    threadModelId: activeConv?.lastModelId ?? null,
    override: modelOverride,
  });
  // Show a skeleton while bootstrapping or while the active thread is still
  // loading — otherwise there's a visible EmptyState flash between the
  // conv-list fetch and the messages fetch.
  const isLoadingMessages =
    !convsLoaded || convLoading || (!!activeConvId && loadedConvId !== activeConvId);
  // Gate the context gauge on the load rather than reading it straight off the
  // session. Clicking a thread in the sidebar flips `activeConvId` in the click
  // handler but only clears the gauge inside the async load, so without this the
  // badge paints one frame of the previous thread's reading under the new
  // thread's title. Every other per-thread surface is already behind this flag.
  const visibleContextUsage = isLoadingMessages ? null : contextUsage;

  React.useEffect(() => {
    // Hydration belongs to a completed load of *this* thread, so leaving one
    // invalidates it. Leaving a thread while it was still loading and coming
    // straight back would otherwise find the ref still holding this id, read
    // as "already loaded", and greet the reader with an old session.
    hydratedConvId.current = undefined;
    dispatchWorkPanel({ type: "thread", conversationId: activeConvId });
  }, [activeConvId]);

  // History is recorded, not reopened: a thread you come back to should not
  // pop a panel onto a diff that was reviewed last week. Once the thread is
  // loaded, a session linked by a reply arriving in front of you is news, and
  // the panel opens itself the way the live browser does — but only where it
  // can sit beside the conversation. On a narrow window opening it covers the
  // screen, and taking someone's screen mid-sentence is not an improvement on
  // a link they can tap.
  React.useEffect(() => {
    if (isLoadingMessages) return;
    const live = hydratedConvId.current === activeConvId && canDockWorkPanel;
    hydratedConvId.current = activeConvId;
    dispatchWorkPanel({ type: "transcript", targets: workTargets, live });
  }, [workTargets, isLoadingMessages, activeConvId, canDockWorkPanel]);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-white dark:bg-slate-950">
      <ConversationList
        convs={convs}
        archivedConvs={session.archivedConvs}
        archivedLoaded={session.archivedLoaded}
        activeId={activeConvId}
        onSelect={(id) => actions.update(emp.id, { activeConvId: id })}
        onDelete={handleDelete}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        onLoadArchived={() =>
          actions
            .loadArchived(company.id, emp.id)
            .catch((err) => toast((err as Error).message, "error"))
        }
        onNew={handleNewClick}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          company={company}
          emp={emp}
          convTitle={activeConv?.title ?? null}
          onNew={handleNewClick}
          browserTarget={
            activeConvId && !activeConv?.legacyUnclaimed ? (
              <ChatBrowserTarget
                companyId={company.id}
                employeeId={emp.id}
                conversationId={activeConvId}
                browserEnabled={Boolean(emp.browserEnabled)}
                initialValue={activeConv?.memberBrowserId ?? null}
              />
            ) : null
          }
        />

        {activeConv?.legacyUnclaimed && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10 sm:px-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  Legacy conversation needs an owner
                </p>
                <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-200/80">
                  This thread predates private Member conversations. Claim it before sending more
                  messages; other owners and admins will no longer be able to claim it.
                </p>
              </div>
              <button
                type="button"
                disabled={claimingLegacy}
                onClick={() => void handleClaimLegacyConversation()}
                className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-amber-700 px-3 text-xs font-medium text-white transition hover:bg-amber-800 disabled:opacity-60 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400"
              >
                {claimingLegacy ? "Claiming…" : "Claim conversation"}
              </button>
            </div>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            onClick={openWorkFromLink}
            className="flex-1 overflow-y-auto bg-slate-50/50 px-4 py-6 dark:bg-slate-900/40 sm:px-8"
          >
            {isLoadingMessages ? (
              <MessageSkeleton />
            ) : visibleMessages.length === 0 &&
              !isActiveResponse &&
              visibleQueuedMessages.length === 0 ? (
              <EmptyState empName={emp.name} empRole={emp.role} onPick={(t) => send(t)} />
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {visibleMessages.map((m, i) => (
                  <TurnBubble
                    key={m.id}
                    message={m}
                    authorName={emp.name}
                    companyId={company.id}
                    companySlug={company.slug}
                    employeeId={emp.id}
                    employeeSlug={emp.slug}
                    showAvatar={i === 0 || visibleMessages[i - 1].role !== m.role}
                    onInspectAction={setInspectAction}
                  />
                ))}
                {isActiveResponse && hasStreamingReply && (
                  <StreamingBubble authorName={emp.name} content={streamingReply} />
                )}
                {showProgressIndicator && progress && (
                  <ProgressIndicator
                    authorName={emp.name}
                    percent={progress.percent}
                    label={progress.label}
                    connectionState={connectionState}
                  />
                )}
                {showTypingIndicator && <TypingIndicator authorName={emp.name} />}
                {visibleQueuedMessages.length > 0 && (
                  <QueuedMessageStack
                    messages={visibleQueuedMessages}
                    empName={emp.name}
                    onRemove={(id) => actions.removeQueuedMessage(emp.id, id)}
                  />
                )}
              </div>
            )}
          </div>
          {showJumpToLatest && (
            <button
              type="button"
              onClick={followTail}
              className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <ArrowDown size={12} /> Jump to latest
            </button>
          )}
        </div>

        {!activeConv?.legacyUnclaimed && (
          <Composer
            inputRef={inputRef}
            value={input}
            onChange={(v) => actions.update(emp.id, { input: v })}
            onSubmit={() => send()}
            isResponding={sending}
            queuedCount={visibleQueuedMessages.length}
            empName={emp.name}
            companyId={company.id}
            companySlug={company.slug}
            attachments={pendingAttachments}
            onUpload={uploadAttachment}
            onRemoveAttachment={removePendingAttachment}
            models={chatModels}
            selectedModelId={selectedModelId}
            onModelChange={(modelId) => setModelOverride({ convId: activeConvId, modelId })}
            contextUsage={visibleContextUsage}
            employeeSlug={emp.slug}
          />
        )}
      </section>

      {/* One companion panel at a time. Two of them either squeeze the
        conversation into a column nobody can read or push it off the screen
        entirely, and repository work is the one the reader just asked for.
        The browser panel is hidden rather than unmounted, so its live viewer
        keeps running and a Member who already dismissed or collapsed it does
        not get it back, full size, when this panel closes. */}
      {workPanel.open && (
        <RepositoryWorkPanel
          companyId={company.id}
          companySlug={company.slug}
          companyRole={company.role}
          currentUserId={currentUserId}
          target={workPanel.open}
          collapsed={workPanel.collapsed}
          onCollapsedChange={(collapsed) => dispatchWorkPanel({ type: "collapse", collapsed })}
          onClose={() => dispatchWorkPanel({ type: "close" })}
        />
      )}
      {emp.browserEnabled && activeConvId && !activeConv?.legacyUnclaimed && (
        <BrowserLivePanel
          companyId={company.id}
          employeeId={emp.id}
          conversationId={activeConvId}
          hidden={Boolean(workPanel.open)}
        />
      )}

      {inspectAction && (
        <ActionDetailModal action={inspectAction} onClose={() => setInspectAction(null)} />
      )}
    </div>
  );
}

function isLocalChatError(message: ConversationMessage): boolean {
  return message.id.startsWith("err-") || message.id.startsWith("local-");
}

// ───────────────────────────── ConversationList ─────────────────────────────

function ConversationList({
  convs,
  archivedConvs,
  archivedLoaded,
  activeId,
  onSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onLoadArchived,
  onNew,
}: {
  convs: ConversationSummary[];
  archivedConvs: ConversationSummary[];
  archivedLoaded: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onLoadArchived: () => void;
  onNew: () => void;
}) {
  const [archivedOpen, setArchivedOpen] = React.useState(false);

  function toggleArchived() {
    const next = !archivedOpen;
    setArchivedOpen(next);
    // Fetch lazily — the archived list is a secondary view most people
    // won't open, so we don't want to pay for it on every Chat mount.
    if (next && !archivedLoaded) onLoadArchived();
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950 md:flex">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-3 dark:border-slate-800">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Conversations
        </div>
        <button
          onClick={onNew}
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          aria-label="New conversation"
          title="New conversation"
        >
          <MessageSquarePlus size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {convs.length === 0 ? (
          <div className="px-2 pt-4 text-xs text-slate-500 dark:text-slate-400">
            No threads yet. Start typing and a new one will appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {convs.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onSelect={onSelect}
                actions={
                  !c.legacyUnclaimed ? (
                    <>
                      <button
                        onClick={() => onArchive(c.id)}
                        className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                        aria-label="Archive conversation"
                        title="Archive"
                      >
                        <Archive size={12} />
                      </button>
                      <button
                        onClick={() => onDelete(c.id)}
                        className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-rose-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-rose-400"
                        aria-label="Delete conversation"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}

        <div className="mt-3 border-t border-slate-200 pt-2 dark:border-slate-800">
          <button
            onClick={toggleArchived}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-expanded={archivedOpen}
          >
            {archivedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="flex-1 text-left">Archived</span>
            {archivedLoaded && archivedConvs.length > 0 && (
              <span className="text-slate-400 dark:text-slate-500">{archivedConvs.length}</span>
            )}
          </button>
          {archivedOpen &&
            (!archivedLoaded ? (
              <div className="px-2 py-2 text-[11px] text-slate-400 dark:text-slate-500">
                Loading…
              </div>
            ) : archivedConvs.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-slate-400 dark:text-slate-500">
                Nothing archived.
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5 pt-1">
                {archivedConvs.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conv={c}
                    active={c.id === activeId}
                    onSelect={onSelect}
                    muted
                    actions={
                      !c.legacyUnclaimed ? (
                        <>
                          <button
                            onClick={() => onUnarchive(c.id)}
                            className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-emerald-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-emerald-400"
                            aria-label="Unarchive conversation"
                            title="Unarchive"
                          >
                            <ArchiveRestore size={12} />
                          </button>
                          <button
                            onClick={() => onDelete(c.id)}
                            className="rounded p-1 text-slate-400 opacity-0 hover:bg-slate-200 hover:text-rose-600 group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-rose-400"
                            aria-label="Delete conversation"
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            ))}
        </div>
      </div>
    </aside>
  );
}

function ConversationRow({
  conv,
  active,
  muted,
  onSelect,
  actions,
}: {
  conv: ConversationSummary;
  active: boolean;
  muted?: boolean;
  onSelect: (id: string) => void;
  actions: React.ReactNode;
}) {
  return (
    <li>
      <div
        className={
          "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm " +
          (active
            ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
            : muted
              ? "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/70"
              : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/70")
        }
      >
        <button
          onClick={() => onSelect(conv.id)}
          className="flex-1 min-w-0 text-left"
          title={conv.title ?? "New conversation"}
        >
          <div className="truncate text-[13px] font-medium">
            {conv.title ?? (
              <span className="italic text-slate-400 dark:text-slate-500">New conversation</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">
            {formatRelative(conv.lastMessageAt ?? conv.updatedAt)}
          </div>
        </button>
        {actions}
      </div>
    </li>
  );
}

// ───────────────────────────── ChatHeader ─────────────────────────────

/**
 * The chat's slice of the shared employee header: identity, the Chat /
 * Settings switch, and the way back to the roster all come from
 * `EmployeeHeader`, so the bar is in the same place on both sides. Chat only
 * adds what is genuinely per-thread — the conversation title and the browser
 * this thread drives.
 */
function ChatHeader({
  company,
  emp,
  convTitle,
  onNew,
  browserTarget,
}: {
  company: Company;
  emp: Employee;
  convTitle: string | null;
  onNew: () => void;
  browserTarget?: React.ReactNode;
}) {
  return (
    <EmployeeHeader
      company={company}
      emp={emp}
      active="chat"
      subtitle={convTitle ?? "New conversation"}
      actions={
        <>
          {browserTarget}
          <button
            onClick={onNew}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 md:hidden dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            aria-label="New conversation"
          >
            <MessageSquarePlus size={13} /> New
          </button>
        </>
      }
    />
  );
}

// ───────────────────────────── Messages ─────────────────────────────

function TurnBubble({
  message,
  authorName,
  companyId,
  companySlug,
  employeeId,
  employeeSlug,
  showAvatar,
  onInspectAction,
}: {
  message: ConversationMessage;
  authorName: string;
  companyId: string;
  companySlug: string;
  employeeId: string;
  employeeSlug: string;
  showAvatar: boolean;
  onInspectAction: (a: MessageAction) => void;
}) {
  const mine = message.role === "user";
  const attachments = message.attachments ?? [];
  const attachmentUrl = (id: string) =>
    `/api/companies/${companyId}/employees/${employeeId}/chat-attachments/${id}`;

  if (mine) {
    return (
      <div className="flex justify-end">
        <div className="group flex max-w-[85%] flex-col items-end gap-1.5 sm:max-w-[75%]">
          {message.content.trim() && (
            <div className="rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm leading-relaxed text-white shadow-sm [&_a]:text-white [&_a]:underline">
              <ChatMarkdown content={message.content} />
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-col items-end gap-1.5">
              {attachments.map((a) => (
                <AttachmentPreview key={a.id} attachment={a} url={attachmentUrl(a.id)} />
              ))}
            </div>
          )}
          <div className="pr-1 text-right text-[10px] text-slate-400 opacity-0 transition group-hover:opacity-100 dark:text-slate-500">
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }

  const isError = message.status === "error";
  const isSkipped = message.status === "skipped";
  // The employee was already mid-Run/mid-chat. Not a failure — an in-progress
  // notice that names them and (for a routine) links the run to watch.
  const isBusy = message.status === "busy";

  return (
    <div className="flex justify-start gap-2.5">
      <div className={"w-9 shrink-0 " + (showAvatar ? "" : "invisible")}>
        <Avatar name={authorName} size={32} />
      </div>
      <div className="group min-w-0 max-w-[85%] sm:max-w-[75%]">
        {showAvatar && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px]">
            <span className="font-medium text-slate-700 dark:text-slate-200">{authorName}</span>
            {isError && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertCircle size={10} /> error
              </span>
            )}
            {isSkipped && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <CircleSlash size={10} /> not available
              </span>
            )}
            {isBusy && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                <Clock size={10} /> working
              </span>
            )}
          </div>
        )}
        <div
          className={
            "rounded-2xl rounded-tl-md px-3.5 py-2 text-sm leading-relaxed shadow-sm " +
            (isError
              ? "border border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
              : isSkipped
                ? "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                : isBusy
                  ? "border border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-100"
                  : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100")
          }
        >
          {isError || isSkipped ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <ChatMarkdown content={message.content} />
          )}
          {isError && !isLocalChatError(message) && (
            <Link
              to={`/c/${companySlug}/employees/${employeeSlug}/settings/model`}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
            >
              <Plug size={12} /> Review AI Model settings
            </Link>
          )}
        </div>
        {attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col items-start gap-1.5">
            {attachments.map((a) => (
              <AttachmentPreview key={a.id} attachment={a} url={attachmentUrl(a.id)} />
            ))}
          </div>
        )}
        {message.actions && message.actions.length > 0 && (
          <ActionPills
            actions={message.actions}
            companySlug={companySlug}
            employeeSlug={employeeSlug}
            onInspect={onInspectAction}
          />
        )}
        <div className="mt-1 pl-1 text-[10px] text-slate-400 opacity-0 transition group-hover:opacity-100 dark:text-slate-500">
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

function StreamingBubble({ authorName, content }: { authorName: string; content: string }) {
  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">
        <Avatar name={authorName} size={32} />
      </div>
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">
          {authorName}
        </div>
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          <ChatMarkdown content={content} />
          <span
            className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-[2px] bg-indigo-500"
            style={{ animation: "chatCursor 1s steps(2) infinite" }}
          />
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ authorName }: { authorName: string }) {
  return (
    <div
      className="flex justify-start gap-2.5"
      role="status"
      aria-live="polite"
      aria-label={`${authorName} is working`}
    >
      <div className="w-9 shrink-0">
        <Avatar name={authorName} size={32} />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">
          {authorName}
        </div>
        <div className="inline-flex items-center gap-1 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <Dot delay="0s" />
          <Dot delay="0.15s" />
          <Dot delay="0.3s" />
        </div>
      </div>
    </div>
  );
}

function ProgressIndicator({
  authorName,
  percent,
  label,
  connectionState,
}: {
  authorName: string;
  percent: number;
  label: string;
  connectionState: EmployeeSession["connectionState"];
}) {
  const indeterminate = isIndeterminateChatProgress(percent, label);

  return (
    <div className="flex justify-start gap-2.5">
      <div className="w-9 shrink-0">
        <Avatar name={authorName} size={32} />
      </div>
      <div className="w-full min-w-0 max-w-[85%] sm:max-w-md">
        <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">
          {authorName}
        </div>
        <div className="rounded-2xl rounded-tl-md border border-slate-200 bg-white px-3.5 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          {indeterminate ? (
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                <LoaderCircle size={15} className="motion-safe:animate-spin" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="break-words text-xs font-medium leading-5 text-slate-700 dark:text-slate-200">
                  {label}
                </div>
                <ProgressConnectionStatus
                  connectionState={connectionState}
                  announcementPrefix={`${authorName}: ${label}`}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-start justify-between gap-4 text-xs">
                <span className="min-w-0 break-words font-medium leading-5 text-slate-700 dark:text-slate-200">
                  {label}
                </span>
                <span className="mt-0.5 shrink-0 font-medium tabular-nums text-slate-500 dark:text-slate-400">
                  {percent}%
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                role="progressbar"
                aria-label={`${authorName} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={`${label}, ${percent}% complete`}
              >
                <div
                  className="h-full min-w-[0.375rem] rounded-full bg-indigo-600 transition-[width] duration-500 ease-out dark:bg-indigo-500"
                  style={{ width: `${percent}%` }}
                  aria-hidden="true"
                />
              </div>
              <ProgressConnectionStatus connectionState={connectionState} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressConnectionStatus({
  connectionState,
  announcementPrefix,
}: {
  connectionState: EmployeeSession["connectionState"];
  announcementPrefix?: string;
}) {
  const reconnecting = connectionState === "reconnecting";
  const live = connectionState === "streaming";
  const label = reconnecting
    ? "Reconnecting…"
    : connectionState === "polling"
      ? "Following saved updates"
      : live
        ? "Live updates"
        : "Checking for updates";
  const tone = reconnecting
    ? "text-amber-700 dark:text-amber-300"
    : live
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-slate-500 dark:text-slate-400";

  return (
    <div
      className={`mt-1.5 inline-flex items-center gap-1.5 text-[11px] ${tone}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={announcementPrefix ? `${announcementPrefix}. ${label}` : undefined}
    >
      {reconnecting ? (
        <RefreshCw size={11} className="motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-500"}`}
          aria-hidden="true"
        />
      )}
      {label}
    </div>
  );
}

function QueuedMessageStack({
  messages,
  empName,
  onRemove,
}: {
  messages: QueuedChatMessage[];
  empName: string;
  onRemove: (id: string) => void;
}) {
  return (
    <section
      className="ml-auto w-full max-w-[85%] rounded-2xl border border-indigo-200/80 bg-indigo-50/70 p-2 shadow-sm dark:border-indigo-500/30 dark:bg-indigo-500/10 sm:max-w-[75%]"
      aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 px-1.5 pb-2 pt-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">
            <Clock size={13} />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-200">
              Up next
            </div>
            <div className="truncate text-[11px] text-indigo-600/80 dark:text-indigo-300/70">
              Sends automatically when {empName} finishes
            </div>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium tabular-nums text-indigo-700 shadow-sm ring-1 ring-indigo-200 dark:bg-slate-900 dark:text-indigo-200 dark:ring-indigo-500/30">
          {messages.length} queued
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {messages.map((message, index) => (
          <div
            key={message.id}
            className="group relative rounded-xl border border-indigo-100 bg-white px-3 py-2.5 pr-9 text-sm leading-relaxed text-slate-800 shadow-sm dark:border-indigo-500/20 dark:bg-slate-900 dark:text-slate-100"
          >
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {index === 0 ? "Next message" : `Then · ${index + 1}`}
            </div>
            {message.content && (
              <div className="break-words">
                <ChatMarkdown content={message.content} />
              </div>
            )}
            {message.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {message.attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    <Paperclip size={11} className="shrink-0" />
                    <span className="truncate">{attachment.filename}</span>
                  </span>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => onRemove(message.id)}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
              aria-label="Remove queued message"
              title="Remove from queue"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
      style={{
        animation: "chatDot 1.2s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}

function MessageSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex justify-start gap-2.5">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-800" />
        <div className="flex flex-col gap-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="h-10 w-64 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="h-10 w-56 animate-pulse rounded-2xl bg-slate-200 dark:bg-slate-800" />
      </div>
    </div>
  );
}

// ───────────────────────────── Empty state ─────────────────────────────

function EmptyState({
  empName,
  empRole,
  onPick,
}: {
  empName: string;
  empRole: string;
  onPick: (prompt: string) => void;
}) {
  const suggestions = [
    `What are you working on right now, ${empName.split(" ")[0]}?`,
    "Help me plan my week.",
    "Summarize what you'd do first on a new project.",
  ];
  return (
    <div className="mx-auto flex h-full min-h-[320px] max-w-2xl flex-col items-center justify-center text-center">
      <Avatar name={empName} size={56} />
      <h2 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">{empName}</h2>
      <div className="text-sm text-slate-500 dark:text-slate-400">{empRole}</div>
      <p className="mt-3 max-w-md text-sm text-slate-500 dark:text-slate-400">
        Messages use {empName}&apos;s Soul and Skills as context. Each send spawns the
        employee&apos;s CLI, so the first reply can take a few seconds.
      </p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-sm text-slate-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-500/10"
          >
            <Sparkles size={14} className="text-indigo-500 transition group-hover:scale-110" />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Composer ─────────────────────────────

function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  isResponding,
  queuedCount,
  empName,
  companyId,
  companySlug,
  attachments,
  onUpload,
  onRemoveAttachment,
  models,
  selectedModelId,
  onModelChange,
  contextUsage,
  employeeSlug,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isResponding: boolean;
  queuedCount: number;
  empName: string;
  companyId: string;
  companySlug: string;
  attachments: ChatAttachment[];
  onUpload: (file: File) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  models: AIModel[];
  selectedModelId: string | null;
  onModelChange: (modelId: string) => void;
  contextUsage: ChatContextUsage | null;
  employeeSlug: string;
}) {
  const canSend = value.trim().length > 0 || attachments.length > 0;
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [resourceQuery, setResourceQuery] = React.useState<string | null>(null);
  const [resourceStart, setResourceStart] = React.useState<number | null>(null);
  const [resourceIndex, setResourceIndex] = React.useState(0);
  const { references, loading: referencesLoading } = useResourceReferences(
    companyId,
    resourceQuery,
  );

  function refreshResourceState(next: string, caret: number) {
    const match = resourceQueryAtCaret(next, caret);
    setResourceQuery(match?.query ?? null);
    setResourceStart(match?.start ?? null);
    setResourceIndex(0);
  }

  function pickResource(reference: ChatResourceReference) {
    const el = inputRef.current;
    if (!el || resourceStart === null) return;
    const inserted = insertResourceReference({
      value,
      caret: el.selectionStart ?? value.length,
      start: resourceStart,
      companySlug,
      reference,
    });
    onChange(inserted.value);
    setResourceQuery(null);
    setResourceStart(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
    });
  }

  async function handleFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        await onUpload(f);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Paste a screenshot or drag a file straight onto the composer — same
  // upload path as the paperclip, no save-to-disk detour. Follow-up
  // attachments remain available while a reply streams and join the queue
  // with the message that references them.
  const { dragActive, onPaste, dragProps } = useComposerFileDrop(
    (files) => void handleFiles(files),
    { disabled: uploading },
  );

  return (
    <form
      className={
        "border-t bg-white px-4 py-3 transition-colors dark:bg-slate-950 sm:px-6 " +
        (isResponding
          ? "border-indigo-200 dark:border-indigo-500/30"
          : "border-slate-200 dark:border-slate-800")
      }
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <Paperclip size={12} className="text-slate-400" />
              <span className="max-w-[180px] truncate text-slate-700 dark:text-slate-200">
                {a.filename}
              </span>
              <span className="text-slate-400">{formatBytes(a.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(a.id)}
                className="ml-1 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
                aria-label={`Remove ${a.filename}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        {...dragProps}
        className={
          "relative flex items-end gap-2 rounded-2xl border bg-white px-3 py-2 transition dark:bg-slate-900 " +
          (dragActive
            ? "border-indigo-500 ring-2 ring-indigo-500/30 "
            : "border-slate-300 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-slate-700 dark:focus-within:border-indigo-500")
        }
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-indigo-50/90 text-sm font-medium text-indigo-700 dark:bg-indigo-950/80 dark:text-indigo-200">
            <Paperclip size={14} className="mr-1.5" /> Drop to attach
          </div>
        )}
        <input
          type="file"
          ref={fileRef}
          className="hidden"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          aria-label="Attach file"
          title="Attach file"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <Paperclip size={16} />
        </button>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            refreshResourceState(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) =>
            refreshResourceState(e.currentTarget.value, e.currentTarget.selectionStart)
          }
          onPaste={onPaste}
          onKeyDown={(e) => {
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
                pickResource(references[resourceIndex] ?? references[0]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setResourceQuery(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder={isResponding ? `Add a follow-up for ${empName}…` : `Message ${empName}…`}
          className="flex-1 resize-none self-center bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
          style={{ maxHeight: 200 }}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={isResponding ? "Queue message" : "Send message"}
          title={isResponding ? "Queue message" : "Send message"}
          className={
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition " +
            (canSend
              ? isResponding
                ? "bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-200 dark:hover:bg-indigo-500/30"
                : "bg-indigo-600 text-white hover:bg-indigo-700"
              : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600")
          }
        >
          {isResponding ? <Clock size={14} /> : <Send size={14} />}
        </button>
        {resourceQuery !== null && (
          <ResourceReferencePicker
            references={references}
            loading={referencesLoading}
            activeIndex={resourceIndex}
            onHover={setResourceIndex}
            onPick={pickResource}
            className="absolute bottom-full left-10 right-10 z-20 mb-2"
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400 dark:text-slate-500">
        <span>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans dark:border-slate-700 dark:bg-slate-800">
            Enter
          </kbd>{" "}
          to send ·{" "}
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-sans dark:border-slate-700 dark:bg-slate-800">
            Shift+Enter
          </kbd>{" "}
          for newline
          {" · "}
          <span className="font-mono">#</span> product areas &amp; resources ·{" "}
          <span className="font-mono">/new</span> new context
        </span>
        <span className="flex flex-wrap items-center justify-end gap-2">
          {uploading ? (
            <span className="italic">Uploading…</span>
          ) : isResponding ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-indigo-600 dark:text-indigo-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
              </span>
              {queuedCount > 0
                ? `${queuedCount} ${queuedCount === 1 ? "message" : "messages"} queued`
                : "Enter queues your follow-up"}
            </span>
          ) : null}
          {contextUsage && (
            <ContextUsageBadge
              usage={contextUsage}
              companySlug={companySlug}
              employeeSlug={employeeSlug}
            />
          )}
          {models.length > 1 && selectedModelId && (
            <label className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
              <Brain size={12} aria-hidden="true" />
              <span className="sr-only">AI Model for this message</span>
              <Select
                aria-label="AI Model for this message"
                value={selectedModelId}
                onChange={(event) => onModelChange(event.target.value)}
                className="max-w-52 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-medium text-slate-600 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {chatModelLabel(model)}
                    {model.isActive ? " (active)" : ""}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </span>
      </div>
    </form>
  );
}

/**
 * How full the model's context window is, in the composer footer.
 *
 * Deliberately not a second bubble in the message column: the employee-authored
 * progress bar already lives there, and two labelled percentages side by side
 * would read as one feature. This sits with the other per-turn facts — the AI
 * Model picker — as a quiet, always-available readout rather than an alert.
 *
 * The unknown-window state is the primary one, not an edge case: an OpenAI
 * subscription model never reports a window and an API-key OpenAI model has
 * none until someone sets it, so that branch links straight to the model
 * settings panel that can fix it.
 */
function ContextUsageBadge({
  usage,
  companySlug,
  employeeSlug,
}: {
  usage: ChatContextUsage;
  companySlug: string;
  employeeSlug: string;
}) {
  const display = describeContextUsage(usage);
  const tint =
    display.tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : "text-slate-500 dark:text-slate-400";

  const body = (
    <>
      <Gauge size={12} aria-hidden="true" />
      <span className="whitespace-nowrap">
        Context <span className="font-medium tabular-nums">{display.label}</span>
      </span>
      {display.fillPercent !== null && (
        <span
          className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          aria-hidden="true"
        >
          <span
            className={
              "block h-full rounded-full " +
              (display.tone === "warn" ? "bg-amber-500" : "bg-indigo-500")
            }
            style={{ width: `${display.fillPercent}%` }}
          />
        </span>
      )}
    </>
  );

  if (display.windowUnknown) {
    return (
      <Link
        to={`/c/${companySlug}/employees/${employeeSlug}/settings/model`}
        title={display.title}
        aria-label={display.title}
        className={`inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 underline decoration-dotted underline-offset-2 transition hover:text-slate-700 dark:hover:text-slate-200 ${tint}`}
      >
        {body}
      </Link>
    );
  }

  return (
    <span
      title={display.title}
      aria-label={display.title}
      role="status"
      className={`inline-flex items-center gap-1.5 px-1 py-0.5 ${tint}`}
    >
      {body}
    </span>
  );
}

function chatModelLabel(model: AIModel): string {
  const provider =
    model.provider === "openai"
      ? "OpenAI"
      : model.provider === "anthropic"
        ? "Anthropic"
        : "Custom";
  return `${provider} · ${model.customEndpointModelId ?? model.model}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreview({ attachment, url }: { attachment: ChatAttachment; url: string }) {
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
      download={attachment.filename}
      title={`Download ${attachment.filename}`}
      className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Paperclip size={12} />
      <span className="max-w-[240px] truncate">{attachment.filename}</span>
      <span className="text-slate-400 dark:text-slate-500">
        {formatBytes(attachment.sizeBytes)}
      </span>
      <Download size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
    </a>
  );
}

// ───────────────────────────── Action pills ─────────────────────────────

/**
 * Inline footer under an assistant bubble showing every tool-driven write
 * the employee performed during that turn (`routine.create`, `todo.create`,
 * ...). Without this the model's prose is the only signal that anything
 * happened, which is how we kept getting "Done — I set up a Routine" replies
 * with no real DB write to back them up. The pills are built from the
 * AuditEvent table server-side, so the evidence is authoritative: no
 * audit row, no pill.
 *
 * `integration.invoke` pills open a logs modal (args + result + status)
 * instead of navigating — there is no list page for tool calls, and the
 * audit metadata carries everything we can show.
 */
function ActionPills({
  actions,
  companySlug,
  employeeSlug,
  onInspect,
}: {
  actions: MessageAction[];
  companySlug: string;
  employeeSlug: string;
  onInspect: (a: MessageAction) => void;
}) {
  // 2+ actions in a turn always roll up into one "X tool calls" chip,
  // regardless of action type. A turn that creates 30 base rows then runs
  // 14 integration calls used to render as 44 inline pills — way more than
  // the reply itself. Single-action turns stay inline so the most common
  // case ("created routine X") is one click from its detail view.
  if (actions.length >= 2) {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <ToolCallGroup
          actions={actions}
          companySlug={companySlug}
          employeeSlug={employeeSlug}
          onInspect={onInspect}
        />
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((a, i) => (
        <ActionPill
          key={`${a.action}-${a.targetId ?? i}`}
          action={a}
          companySlug={companySlug}
          employeeSlug={employeeSlug}
          onInspect={onInspect}
        />
      ))}
    </div>
  );
}

function ToolCallGroup({
  actions,
  companySlug,
  employeeSlug,
  onInspect,
}: {
  actions: MessageAction[];
  companySlug: string;
  employeeSlug: string;
  onInspect: (a: MessageAction) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const errorCount = actions.filter((a) => a.metadata?.status === "error").length;
  const hasError = errorCount > 0;
  const palette = hasError
    ? "border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:border-rose-500/50 dark:hover:bg-rose-500/20"
    : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800";
  const className = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition cursor-pointer ${palette}`;
  const label = `${actions.length} tool call${actions.length === 1 ? "" : "s"}`;
  const errorSuffix = hasError ? ` · ${errorCount} failed` : "";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={className}
        aria-expanded={open}
        title={open ? "Hide tool calls" : "Show tool calls"}
      >
        {open ? (
          <ChevronDown size={11} strokeWidth={2.5} />
        ) : (
          <ChevronRight size={11} strokeWidth={2.5} />
        )}
        <span>
          {label}
          {errorSuffix}
        </span>
      </button>
      {open && (
        <div className="w-full pl-3">
          <div className="flex flex-wrap gap-1.5">
            {actions.map((a, i) => (
              <ActionPill
                key={`${a.action}-${a.targetId ?? i}-tg`}
                action={a}
                companySlug={companySlug}
                employeeSlug={employeeSlug}
                onInspect={onInspect}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ActionPill({
  action,
  companySlug,
  employeeSlug,
  onInspect,
}: {
  action: MessageAction;
  companySlug: string;
  employeeSlug: string;
  onInspect: (a: MessageAction) => void;
}) {
  const isIntegration = action.action === "integration.invoke";
  const isError = isIntegration && action.metadata?.status === "error";
  const href = isIntegration ? null : hrefForAction(action, companySlug, employeeSlug);

  const palette = isError
    ? "border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:border-rose-500/50 dark:hover:bg-rose-500/20"
    : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-500/20";
  const base =
    "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition";
  const className = `${base} ${palette}`;
  const title = buildPillTitle(action);

  const icon = isIntegration ? (
    isError ? (
      <AlertCircle size={11} strokeWidth={2.5} />
    ) : (
      <Zap size={11} strokeWidth={2.5} />
    )
  ) : (
    <Check size={11} strokeWidth={3} />
  );
  const content = (
    <>
      {icon}
      <span className="truncate max-w-[22rem]">{describeAction(action)}</span>
    </>
  );

  if (isIntegration) {
    return (
      <button
        type="button"
        onClick={() => onInspect(action)}
        title={title}
        className={`${className} cursor-pointer`}
      >
        {content}
      </button>
    );
  }
  if (href) {
    return (
      <Link to={href} title={title} className={className}>
        {content}
      </Link>
    );
  }
  // Action has no detail surface (e.g. unknown kind). Render a static chip.
  const staticClass = className.replace(/\s+hover:[^\s]+/g, "");
  return (
    <span title={`${title} (no link available)`} className={staticClass}>
      {content}
    </span>
  );
}

function buildPillTitle(a: MessageAction): string {
  const parts: string[] = [a.action];
  if (a.targetLabel) parts.push(a.targetLabel);
  if (a.metadata?.status === "error" && a.metadata.error) {
    parts.push(`error: ${a.metadata.error}`);
  } else if (a.action === "integration.invoke" && typeof a.metadata?.durationMs === "number") {
    parts.push(`${formatDuration(a.metadata.durationMs)}`);
  }
  return parts.join(" — ");
}

/**
 * Route the pill should deep-link to. Routines/journal are scoped to the
 * employee who took the action; project/todo live under the company-wide
 * Tasks section. We intentionally land on the list view rather than a
 * detail page — the new row is near the top, so it's easy to spot, and we
 * don't have to carry the project slug through the action payload.
 */
function hrefForAction(a: MessageAction, companySlug: string, employeeSlug: string): string | null {
  if (a.action.startsWith("routine.")) {
    return `/c/${companySlug}/routines?employee=${employeeSlug}`;
  }
  if (a.action === "journal.create" || a.action.startsWith("journal.")) {
    return `/c/${companySlug}/employees/${employeeSlug}/settings/journal`;
  }
  if (a.action.startsWith("project.") || a.action.startsWith("todo.")) {
    return `/c/${companySlug}/tasks`;
  }
  if (a.action === "finance.estimate.create") {
    return `/c/${companySlug}/finance/estimates`;
  }
  return null;
}

/**
 * Human sentence for an action pill. Keeps it terse — the hover title
 * carries the raw action name for anyone who wants to see it.
 */
function describeAction(a: MessageAction): string {
  const label = a.targetLabel || a.targetType || "item";
  switch (a.action) {
    case "routine.create":
      return `Created routine "${label}"`;
    case "routine.update":
      return `Updated routine "${label}"`;
    case "project.create":
      return `Created project "${label}"`;
    case "todo.create":
      return `Created todo ${label}`;
    case "todo.update":
      return `Updated todo ${label}`;
    case "journal.create":
      return `Added journal entry "${label}"`;
    case "finance.estimate.create":
      return `Created estimate ${label}`;
    case "integration.invoke": {
      const tool = a.metadata?.toolName ?? "";
      const conn = a.metadata?.connectionLabel ?? a.metadata?.provider ?? "";
      if (tool && conn) return `${conn} · ${tool}`;
      if (tool) return tool;
      return label;
    }
    default:
      return `${a.action}${label ? ` — ${label}` : ""}`;
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// ───────────────────────────── Action detail modal ─────────────────────────────

/**
 * Tool-call inspector. Opens when the user clicks an `integration.invoke`
 * pill. Shows the connection we dispatched to, the exact args the AI
 * supplied, and the raw response (or error). This is the "complete
 * visibility" guarantee — if a pill claims the Metabase revenue dashboard
 * was fetched, the human can verify by reading the same JSON the AI saw.
 */
function ActionDetailModal({ action, onClose }: { action: MessageAction; onClose: () => void }) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = action.metadata ?? {};
  const isError = meta.status === "error";
  const isIntegration = action.action === "integration.invoke";
  const providerLabel = meta.connectionLabel ?? meta.provider ?? action.targetLabel ?? "Tool call";
  const toolName = meta.toolName ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              isError
                ? "bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300"
                : "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"
            }`}
          >
            {isIntegration ? <Plug size={18} /> : <Zap size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {providerLabel}
              {toolName && (
                <span className="text-slate-400 dark:text-slate-500">
                  {" · "}
                  <span className="font-mono text-[13px] font-medium text-slate-700 dark:text-slate-300">
                    {toolName}
                  </span>
                </span>
              )}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              <StatusChip status={meta.status} />
              {meta.provider && (
                <span>
                  Provider{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {meta.provider}
                  </span>
                </span>
              )}
              {typeof meta.durationMs === "number" && (
                <span>
                  Took{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {formatDuration(meta.durationMs)}
                  </span>
                </span>
              )}
              {meta.via && (
                <span>
                  via{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-300">{meta.via}</span>
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <LogSection title="Arguments" body={meta.argsPreview ?? ""} empty="No arguments sent." />
          {isError ? (
            <LogSection
              title="Error"
              body={meta.error ?? "Integration call failed."}
              tone="error"
              empty=""
            />
          ) : (
            <LogSection
              title="Result"
              body={meta.resultPreview ?? ""}
              empty="The tool returned no body."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: "ok" | "error" | undefined }) {
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
        <Check size={10} strokeWidth={3} /> ok
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
        <AlertCircle size={10} /> error
      </span>
    );
  }
  return null;
}

function LogSection({
  title,
  body,
  empty,
  tone = "default",
}: {
  title: string;
  body: string;
  empty: string;
  tone?: "default" | "error";
}) {
  const pretty = formatJsonish(body);
  const show = pretty.trim().length > 0 ? pretty : empty;
  const frame =
    tone === "error"
      ? "border-rose-200 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100"
      : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200";
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {title}
        </h3>
      </div>
      <pre
        className={`max-h-64 overflow-auto rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${frame} whitespace-pre-wrap break-words font-mono`}
      >
        {show}
      </pre>
    </section>
  );
}

/**
 * The server writes args/result as already-pretty-printed JSON strings,
 * but old rows (or single-string payloads like Stripe's error messages)
 * may be plain text. Try to re-parse + re-indent JSON for readability,
 * fall back to the raw text.
 */
function formatJsonish(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ───────────────────────────── Markdown ─────────────────────────────

// ───────────────────────────── Helpers ─────────────────────────────

function Avatar({ name, size }: { name: string; size: number }) {
  const initials = getInitials(name);
  const gradient = gradientFor(name);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-sm"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: gradient,
      }}
      aria-hidden
    >
      {initials}
    </div>
  );
}

function getInitials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic pastel gradient per name, so the same employee always gets
 * the same avatar colors across reloads.
 */
function gradientFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const h1 = h;
  const h2 = (h + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 72% 45%))`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
