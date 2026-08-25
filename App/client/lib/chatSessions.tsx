import React from "react";
import {
  api,
  ChatAttachment,
  ChatContextUsage,
  ChatProgress,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
} from "./api";
import { latestContextUsage, parseContextUsageEvent } from "./chatContextUsage";

/**
 * Per-employee chat state held at the company-shell level so it survives
 * page navigation. Without this the EmployeeChat component unmounts every
 * time the user clicks Tasks / Settings / Bases mid-conversation, and loses
 * the active thread, the in-progress streaming reply, and any typed-but-
 * unsent text.
 */
/**
 * One thread's in-flight turn.
 *
 * Held per conversation rather than per employee, because an AI Employee
 * answers each of their threads independently: sending in one conversation
 * must not park a message typed in another behind it. Everything here is
 * scoped to a single thread — its live reply text, its progress, how this
 * browser is following it, and any follow-ups queued behind it.
 */
export type ConversationFlight = {
  /** Conversation this turn belongs to; null until a lazy create resolves. */
  conversationId: string | null;
  /** Intent boundary while the Conversation row does not exist yet. */
  newConversationIntent: number;
  /** True while a turn in this thread is running or being followed. */
  sending: boolean;
  /**
   * True once this browser has asked Genosyn to stop this thread's reply, held
   * until that turn actually finalizes so the button cannot be pressed twice
   * while the agent unwinds.
   */
  interrupting: boolean;
  /** Running text for the in-flight assistant reply; null when no stream. */
  streamingReply: string | null;
  /** Latest employee-authored progress update for the in-flight reply. */
  progress: ChatProgress | null;
  /** How this browser is following the durable in-flight turn. */
  connectionState: "streaming" | "polling" | "reconnecting" | null;
  /** Follow-up messages waiting for *this thread's* current reply to finish. */
  queuedMessages: QueuedChatMessage[];
};

export type EmployeeSession = {
  activeConvId: string | null;
  /** Conversation the current `messages` array belongs to. */
  loadedConvId: string | null;
  messages: ConversationMessage[];
  /**
   * How full the model's context window is in this thread.
   *
   * Unlike a flight's progress this is *not* an in-flight-only signal. It
   * describes the turn that just ran and stays on screen after the reply lands
   * — that is the moment a Member actually wants to read it, before deciding
   * whether to keep going or start a fresh context. It is cleared only when the
   * thread changes, and re-derived from the loaded transcript on every load.
   */
  contextUsage: ChatContextUsage | null;
  /**
   * Threads with a turn in flight or follow-ups queued, keyed by
   * {@link chatFlightKey}. A thread with neither has no entry.
   */
  flights: Record<string, ConversationFlight>;
  /** Client-only boundary for the selected, possibly not-yet-created thread. */
  newConversationIntent: number;
  input: string;
  /** Active (non-archived) threads, newest first. */
  convs: ConversationSummary[];
  /** Archived threads, loaded lazily when the user opens the disclosure. */
  archivedConvs: ConversationSummary[];
  /** True once the conversation list has been fetched for this employee. */
  convsLoaded: boolean;
  /** True once the archived list has been fetched at least once. */
  archivedLoaded: boolean;
  /** True while the active conversation's messages are loading. */
  convLoading: boolean;
};

export type QueuedChatMessage = {
  id: string;
  conversationId: string | null;
  /** Client-only boundary between distinct not-yet-created conversations. */
  newConversationIntent: number;
  /** AI Model captured when this message entered the follow-up queue. */
  modelId: string | null;
  content: string;
  attachments: ChatAttachment[];
  queuedAt: string;
};

const EMPTY: EmployeeSession = Object.freeze({
  activeConvId: null,
  loadedConvId: null,
  messages: [],
  contextUsage: null,
  flights: {},
  newConversationIntent: 0,
  input: "",
  convs: [],
  archivedConvs: [],
  convsLoaded: false,
  archivedLoaded: false,
  convLoading: false,
}) as EmployeeSession;

/** A thread with nothing in flight, so callers never branch on undefined. */
export const IDLE_FLIGHT: ConversationFlight = Object.freeze({
  conversationId: null,
  newConversationIntent: 0,
  sending: false,
  interrupting: false,
  streamingReply: null,
  progress: null,
  connectionState: null,
  queuedMessages: [],
}) as ConversationFlight;

/**
 * Identify a thread for the purposes of "is a turn running here".
 *
 * A saved Conversation is its id. A staged thread whose row does not exist yet
 * is its intent, which is what keeps two drafts — say an older new-chat and a
 * freshly staged TLDR handoff — from being treated as the same thread.
 */
export function chatFlightKey(
  conversationId: string | null,
  newConversationIntent: number,
): string {
  return conversationId ? `conv:${conversationId}` : `new:${newConversationIntent}`;
}

/** The flight for a thread, or the idle one when nothing is running there. */
export function flightFor(
  session: EmployeeSession,
  conversationId: string | null,
  newConversationIntent: number,
): ConversationFlight {
  return session.flights[chatFlightKey(conversationId, newConversationIntent)] ?? IDLE_FLIGHT;
}

/** The flight for whatever thread the Member is currently looking at. */
export function activeFlight(session: EmployeeSession): ConversationFlight {
  return flightFor(session, session.activeConvId, session.newConversationIntent);
}

/** Key for one thread's synchronous worker/queue refs. */
function pendingKey(empId: string, flightKey: string): string {
  return `${empId}|${flightKey}`;
}

/**
 * Update the live fields of one thread's flight, ignoring threads that have
 * already finished. A late event from a stream we stopped following must not
 * resurrect its flight and leave the composer waiting forever.
 */
function patchFlight(
  flights: EmployeeSession["flights"],
  key: string,
  patch: Partial<ConversationFlight>,
): EmployeeSession["flights"] {
  const flight = flights[key];
  if (!flight?.sending) return flights;
  return { ...flights, [key]: { ...flight, ...patch } };
}

/** Flag one thread as reconnecting, if it still has a turn to reconnect to. */
function markReconnecting(session: EmployeeSession, conversationId: string): EmployeeSession {
  const key = chatFlightKey(conversationId, session.newConversationIntent);
  const flight = session.flights[key];
  if (!flight?.sending || flight.connectionState === "reconnecting") return session;
  return {
    ...session,
    flights: { ...session.flights, [key]: { ...flight, connectionState: "reconnecting" } },
  };
}

/** Drop a thread's entry once it has neither a running turn nor a queue. */
function withFlight(
  flights: EmployeeSession["flights"],
  key: string,
  flight: ConversationFlight,
): EmployeeSession["flights"] {
  if (!flight.sending && flight.queuedMessages.length === 0) {
    if (!(key in flights)) return flights;
    const next = { ...flights };
    delete next[key];
    return next;
  }
  return { ...flights, [key]: flight };
}

type Update = Partial<EmployeeSession> | ((s: EmployeeSession) => EmployeeSession);

type ChatActions = {
  update: (empId: string, u: Update) => void;
  initEmployee: (companyId: string, empId: string) => Promise<void>;
  selectConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  refreshConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  newConversation: (companyId: string, empId: string) => Promise<void>;
  stageNewConversation: (companyId: string, empId: string, starterPrompt: string) => Promise<void>;
  claimConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  deleteConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  archiveConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  unarchiveConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  loadArchived: (companyId: string, empId: string) => Promise<void>;
  /** Resolves with an error message on failure, or null on success. */
  send: (
    companyId: string,
    empId: string,
    message: string,
    opts?: {
      clearInput?: boolean;
      attachments?: ChatAttachment[];
      modelId?: string | null;
      /**
       * Stop the reply already in flight in this thread and put this message at
       * the head of its queue, instead of waiting the employee out.
       */
      interrupt?: boolean;
    },
  ) => Promise<string | null>;
  removeQueuedMessage: (empId: string, queuedMessageId: string) => void;
  /** Move a waiting follow-up to the head of its own thread's queue. */
  promoteQueuedMessage: (empId: string, queuedMessageId: string) => void;
  /**
   * Ask the server to stop the reply streaming in one conversation. Resolves
   * with an error message on failure, or null when there was something to stop
   * or nothing left to stop.
   */
  interruptActiveTurn: (
    companyId: string,
    empId: string,
    conversationId: string | null,
  ) => Promise<string | null>;
};

type ChatSessionsCtx = {
  sessions: Record<string, EmployeeSession>;
  actions: ChatActions;
};

const Ctx = React.createContext<ChatSessionsCtx | null>(null);
const CHAT_RECOVERY_POLL_MS = 2_000;

type PendingChatMessage = QueuedChatMessage & {
  resolve: (error: string | null) => void;
};

/**
 * Bind only queued follow-ups that belong to the lazy-created conversation.
 * A staged TLDR discussion advances the intent, so it stays null and creates
 * its own thread after any older in-flight turn finishes.
 */
export function bindLazyCreatedConversation<T extends QueuedChatMessage>(
  messages: T[],
  createdIntent: number,
  conversationId: string,
): T[] {
  return messages.map((message) =>
    !message.conversationId && message.newConversationIntent === createdIntent
      ? ({ ...message, conversationId } as T)
      : message,
  );
}

/** Keep a newer staged/selected context from being replaced by an older POST. */
export function resolveLazyCreatedSelection(
  currentIntent: number,
  createdIntent: number,
  currentConversationId: string | null,
  createdConversationId: string,
): string | null {
  return currentIntent === createdIntent ? createdConversationId : currentConversationId;
}

/**
 * Move one waiting follow-up to the head of the queue, in place.
 *
 * Returns the same array when the message is already next or isn't in this
 * list at all — the queue is kept in two representations (a synchronous ref
 * the worker drains, and the rendered mirror), and only one of them holds any
 * given message once the worker has shifted it off.
 */
export function moveQueuedMessageToFront<T extends { id: string }>(
  messages: T[],
  queuedMessageId: string,
): T[] {
  const index = messages.findIndex((message) => message.id === queuedMessageId);
  if (index <= 0) return messages;
  const next = [...messages];
  const [promoted] = next.splice(index, 1);
  next.unshift(promoted);
  return next;
}

/** Render an optimistic message only in the context that originally queued it. */
export function shouldRenderQueuedMessage(
  conversationId: string | null,
  currentConversationId: string | null,
  messageIntent: number,
  currentIntent: number,
): boolean {
  return conversationId
    ? currentConversationId === conversationId
    : currentConversationId === null && messageIntent === currentIntent;
}

export function ChatSessionsProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = React.useState<Record<string, EmployeeSession>>({});
  // Ref so async code (stream callbacks, lazy-create paths) can read the
  // current sessions without waiting for a re-render.
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;
  // Synchronous queue state prevents two fast Enter presses from racing a
  // React render. The serializable mirror lives on EmployeeSession for UI.
  // Both are keyed by `<employeeId>|<flightKey>` so each thread drains its own
  // follow-ups: a reply running in one conversation never holds up another.
  const pendingRef = React.useRef<Record<string, PendingChatMessage[]>>({});
  const workersRef = React.useRef(new Set<string>());
  /**
   * Staged flight key → the real one, for a thread whose Conversation was
   * created by its own first send.
   *
   * The rekey is synchronous but `send` reads the conversation id out of
   * `sessionsRef`, which only catches up on the next render. In that window
   * `send` would compute the staged key, find no worker under it, and start a
   * second worker — which creates a second Conversation for a message the
   * Member meant for the first. Following this alias closes the window; the
   * old employee-wide worker key never had it because it never changed.
   */
  const flightAliasRef = React.useRef<
    Record<string, { flightKey: string; conversationId: string }>
  >({});
  // Distinguishes separate drafts whose Conversation rows do not exist yet.
  // In particular, a TLDR handoff must not be adopted by an older lazy POST.
  const newConversationIntentRef = React.useRef<Record<string, number>>({});

  const update = React.useCallback((empId: string, u: Update) => {
    setSessions((prev) => {
      const cur = prev[empId] ?? EMPTY;
      const next = typeof u === "function" ? u(cur) : { ...cur, ...u };
      if (next === cur) return prev;
      return { ...prev, [empId]: next };
    });
  }, []);

  const applyConversationDetail = React.useCallback(
    (
      empId: string,
      convId: string,
      detail: ConversationDetail,
      connectionState: "polling" | "reconnecting" = "polling",
    ) => {
      const working = latestWorkingMessage(detail.messages);
      update(empId, (s) => {
        // The freshly-loaded row is newer than whatever the sidebar cached, so
        // fold it back in — otherwise a thread whose model or title changed in
        // another tab keeps reopening on the stale summary.
        const convs = withRefreshedSummary(s.convs, detail.conversation);
        const archivedConvs = withRefreshedSummary(s.archivedConvs, detail.conversation);
        // The flight belongs to this conversation, not to whichever thread the
        // Member happens to be looking at — a turn keeps being followed while
        // they read another one.
        const key = chatFlightKey(convId, s.newConversationIntent);
        const current = s.flights[key];
        let flights = s.flights;
        if (working) {
          flights = withFlight(flights, key, {
            ...(current ?? IDLE_FLIGHT),
            conversationId: convId,
            sending: true,
            progress: progressForWorkingMessage(working),
            connectionState,
          });
        } else if (current?.sending) {
          // The turn we were following finished — including one stopped on
          // purpose, which is what clears the pending interrupt. Any follow-ups
          // queued behind it stay: the drain loop starts the next one
          // immediately.
          flights = withFlight(flights, key, {
            ...current,
            sending: false,
            interrupting: false,
            streamingReply: null,
            progress: null,
            connectionState: null,
          });
        }
        if (s.activeConvId !== convId) {
          if (convs === s.convs && archivedConvs === s.archivedConvs && flights === s.flights) {
            return s;
          }
          return { ...s, convs, archivedConvs, flights };
        }
        return {
          ...s,
          convs,
          archivedConvs,
          flights,
          messages: detail.messages,
          loadedConvId: convId,
          convLoading: false,
          // Always re-derived from the thread we just loaded, never merged with
          // whatever the previous thread left behind. A turn recovered by
          // another process has no SSE subscriber at all, so the persisted row
          // is the only place its reading exists — including while it is still
          // `working`, which is what keeps the gauge live under polling.
          contextUsage: latestContextUsage(detail.messages),
        };
      });
      return working;
    },
    [update],
  );

  const removeQueuedMessage = React.useCallback(
    (empId: string, queuedMessageId: string) => {
      const prefix = `${empId}|`;
      for (const pendingKey of Object.keys(pendingRef.current)) {
        if (!pendingKey.startsWith(prefix)) continue;
        const queue = pendingRef.current[pendingKey] ?? [];
        const index = queue.findIndex((item) => item.id === queuedMessageId);
        if (index === -1) continue;
        const [removed] = queue.splice(index, 1);
        removed.resolve(null);
        const flightKey = pendingKey.slice(prefix.length);
        update(empId, (s) => {
          const flight = s.flights[flightKey];
          if (!flight) return s;
          return {
            ...s,
            flights: withFlight(s.flights, flightKey, {
              ...flight,
              queuedMessages: flight.queuedMessages.filter((item) => item.id !== queuedMessageId),
            }),
          };
        });
        return;
      }
    },
    [update],
  );

  /**
   * Move a waiting follow-up to the head of its own thread's queue.
   *
   * Both the synchronous `pendingRef` queue and its rendered mirror move
   * together — the worker drains the ref, so reordering only one of them would
   * send a different message than the card the Member pressed.
   */
  const promoteQueuedMessage = React.useCallback(
    (empId: string, queuedMessageId: string) => {
      const prefix = `${empId}|`;
      for (const key of Object.keys(pendingRef.current)) {
        if (!key.startsWith(prefix)) continue;
        const queue = pendingRef.current[key] ?? [];
        if (!queue.some((item) => item.id === queuedMessageId)) continue;
        pendingRef.current[key] = moveQueuedMessageToFront(queue, queuedMessageId);
        break;
      }
      update(empId, (s) => {
        let flights = s.flights;
        for (const [key, flight] of Object.entries(s.flights)) {
          const queuedMessages = moveQueuedMessageToFront(flight.queuedMessages, queuedMessageId);
          if (queuedMessages === flight.queuedMessages) continue;
          flights = { ...flights, [key]: { ...flight, queuedMessages } };
          break;
        }
        return flights === s.flights ? s : { ...s, flights };
      });
    },
    [update],
  );

  /**
   * Ask the server to stop the reply one conversation is streaming.
   *
   * Nothing local is torn down. The turn is durable, so the server finalizes
   * the row and the same SSE stream (or the recovery poll) delivers the
   * partial reply — which is what releases that thread's queue worker to send
   * the next message. Tearing the client state down here would race that.
   */
  const interruptActiveTurn = React.useCallback(
    async (
      companyId: string,
      empId: string,
      conversationId: string | null,
    ): Promise<string | null> => {
      const session = sessionsRef.current[empId] ?? EMPTY;
      const convId = conversationId ?? session.activeConvId;
      if (!convId) return null;
      const key = chatFlightKey(convId, session.newConversationIntent);
      if (!session.flights[key]?.sending) return null;
      // Deliberately not skipped when a stop is already pending: the endpoint
      // is idempotent, and refusing here would turn any stranded flag into a
      // button that silently does nothing. The flag only drives the label.
      update(empId, (s) => ({
        ...s,
        flights: patchFlight(s.flights, key, { interrupting: true }),
      }));
      try {
        await api.post<{ interrupted: boolean }>(
          `/api/companies/${companyId}/employees/${empId}/conversations/${convId}/interrupt`,
          {},
        );
        return null;
      } catch (error) {
        update(empId, (s) => ({
          ...s,
          flights: patchFlight(s.flights, key, { interrupting: false }),
        }));
        return (error as Error).message || "Could not stop the reply.";
      }
    },
    [update],
  );

  const initEmployee = React.useCallback(
    async (companyId: string, empId: string) => {
      if (sessionsRef.current[empId]?.convsLoaded) return;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const list = await api.get<ConversationSummary[]>(`${base}/conversations`);
      update(empId, (s) => {
        // A staged guided handoff or another loader may have won while this
        // request was in flight. Do not overwrite its deliberate selection.
        if (s.convsLoaded) return s;
        return {
          ...s,
          convs: list,
          convsLoaded: true,
          // Only auto-select the newest thread on first load; returning to
          // this employee later reuses whatever they had selected.
          activeConvId: s.activeConvId ?? list[0]?.id ?? null,
        };
      });
    },
    [update],
  );

  const selectConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const cur = sessionsRef.current[empId] ?? EMPTY;
      if (cur.loadedConvId === convId && cur.activeConvId === convId) return;
      const nextIntent = (newConversationIntentRef.current[empId] ?? 0) + 1;
      newConversationIntentRef.current[empId] = nextIntent;
      // Drop the previous thread's gauge immediately; `applyConversationDetail`
      // re-derives it from whatever this conversation actually holds.
      update(empId, {
        activeConvId: convId,
        convLoading: true,
        contextUsage: null,
        newConversationIntent: nextIntent,
      });
      const base = `/api/companies/${companyId}/employees/${empId}`;
      try {
        const detail = await api.get<ConversationDetail>(`${base}/conversations/${convId}`);
        // Drop the response if the user switched away before it returned.
        if (sessionsRef.current[empId]?.activeConvId !== convId) return;
        applyConversationDetail(empId, convId, detail);
      } catch (err) {
        if (sessionsRef.current[empId]?.activeConvId === convId) {
          update(empId, { convLoading: false });
        }
        throw err;
      }
    },
    [applyConversationDetail, update],
  );

  const refreshConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      try {
        const detail = await api.get<ConversationDetail>(`${base}/conversations/${convId}`);
        applyConversationDetail(empId, convId, detail);
      } catch (error) {
        update(empId, (s) => markReconnecting(s, convId));
        throw error;
      }
    },
    [applyConversationDetail, update],
  );

  const newConversation = React.useCallback(
    async (companyId: string, empId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const nextIntent = (newConversationIntentRef.current[empId] ?? 0) + 1;
      newConversationIntentRef.current[empId] = nextIntent;
      update(empId, { newConversationIntent: nextIntent });
      const created = await api.post<ConversationSummary>(`${base}/conversations`, {});
      update(empId, (s) => {
        const convs = [
          created,
          ...s.convs.filter((conversation) => conversation.id !== created.id),
        ];
        // A later select/stage action wins even if this POST returns last.
        if (newConversationIntentRef.current[empId] !== nextIntent) return { ...s, convs };
        return {
          ...s,
          convs,
          activeConvId: created.id,
          loadedConvId: created.id,
          messages: [],
          contextUsage: null,
          newConversationIntent: nextIntent,
          input: "",
        };
      });
    },
    [update],
  );

  /**
   * Open an unsaved thread with a reviewable draft. The first explicit Send
   * lazily creates the Conversation, so guided handoffs do not leave empty
   * rows when a Member opens Chat and changes their mind.
   */
  const stageNewConversation = React.useCallback(
    async (companyId: string, empId: string, starterPrompt: string) => {
      const nextIntent = (newConversationIntentRef.current[empId] ?? 0) + 1;
      newConversationIntentRef.current[empId] = nextIntent;
      update(empId, { newConversationIntent: nextIntent });
      const existing = sessionsRef.current[empId];
      const conversations = existing?.convsLoaded
        ? null
        : await api.get<ConversationSummary[]>(
            `/api/companies/${companyId}/employees/${empId}/conversations`,
          );
      update(empId, (session) => {
        // Preserve any conversation created while the list request was in
        // flight, then fill in rows the request knew about.
        const fetched = conversations ?? [];
        const knownIds = new Set(session.convs.map((conversation) => conversation.id));
        const convs = session.convsLoaded
          ? session.convs
          : [...session.convs, ...fetched.filter((conversation) => !knownIds.has(conversation.id))];
        // A later select/new/stage action wins even if this list request
        // returns last. Its fetched rows are still safe to merge.
        if (newConversationIntentRef.current[empId] !== nextIntent) {
          return { ...session, convs, convsLoaded: true };
        }
        return {
          ...session,
          convs,
          convsLoaded: true,
          activeConvId: null,
          loadedConvId: null,
          messages: [],
          contextUsage: null,
          convLoading: false,
          newConversationIntent: nextIntent,
          input: starterPrompt,
        };
      });
    },
    [update],
  );

  const deleteConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      await api.del(`${base}/conversations/${convId}`);
      update(empId, (s) => {
        const wasActive = s.activeConvId === convId;
        return {
          ...s,
          convs: s.convs.filter((c) => c.id !== convId),
          archivedConvs: s.archivedConvs.filter((c) => c.id !== convId),
          activeConvId: wasActive ? null : s.activeConvId,
          loadedConvId: wasActive ? null : s.loadedConvId,
          messages: wasActive ? [] : s.messages,
          contextUsage: wasActive ? null : s.contextUsage,
        };
      });
    },
    [update],
  );

  const claimConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const claimed = await api.post<ConversationSummary>(
        `${base}/conversations/${convId}/claim`,
        {},
      );
      update(empId, (s) => ({
        ...s,
        convs: s.convs.map((conversation) => (conversation.id === convId ? claimed : conversation)),
        archivedConvs: s.archivedConvs.map((conversation) =>
          conversation.id === convId ? claimed : conversation,
        ),
      }));
    },
    [update],
  );

  const loadArchived = React.useCallback(
    async (companyId: string, empId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const list = await api.get<ConversationSummary[]>(`${base}/conversations?archived=1`);
      update(empId, { archivedConvs: list, archivedLoaded: true });
    },
    [update],
  );

  const archiveConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const updated = await api.post<ConversationSummary>(
        `${base}/conversations/${convId}/archive`,
        {},
      );
      update(empId, (s) => {
        const wasActive = s.activeConvId === convId;
        return {
          ...s,
          convs: s.convs.filter((c) => c.id !== convId),
          archivedConvs: [updated, ...s.archivedConvs.filter((c) => c.id !== convId)],
          activeConvId: wasActive ? null : s.activeConvId,
          loadedConvId: wasActive ? null : s.loadedConvId,
          messages: wasActive ? [] : s.messages,
          contextUsage: wasActive ? null : s.contextUsage,
        };
      });
    },
    [update],
  );

  const unarchiveConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const updated = await api.post<ConversationSummary>(
        `${base}/conversations/${convId}/unarchive`,
        {},
      );
      update(empId, (s) => ({
        ...s,
        archivedConvs: s.archivedConvs.filter((c) => c.id !== convId),
        convs: [updated, ...s.convs.filter((c) => c.id !== convId)],
      }));
    },
    [update],
  );

  const sendTurn = React.useCallback(
    async (
      companyId: string,
      empId: string,
      message: string,
      opts?: {
        clearInput?: boolean;
        attachments?: ChatAttachment[];
        conversationId?: string | null;
        newConversationIntent?: number;
        modelId?: string | null;
        /**
         * Fired the moment a lazily-created Conversation gets its id, so the
         * caller's queue can follow the thread onto its real key.
         */
        onConversationCreated?: (conversationId: string) => void;
      },
    ): Promise<string | null> => {
      const msg = message.trim();
      const attachments = opts?.attachments ?? [];
      if (!msg && attachments.length === 0) return null;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const clearInput = opts?.clearInput ?? true;
      // An explicit null belongs to a staged, not-yet-created conversation.
      // Do not reinterpret it as whichever older thread happens to be active
      // by the time this queued message drains.
      let convId =
        opts?.conversationId === undefined
          ? (sessionsRef.current[empId]?.activeConvId ?? null)
          : opts.conversationId;
      const newConversationIntent =
        opts?.newConversationIntent ?? newConversationIntentRef.current[empId] ?? 0;
      const tempId = `temp-${Date.now()}`;
      const tempUser: ConversationMessage = {
        id: tempId,
        conversationId: convId ?? "",
        role: "user",
        content: msg,
        status: null,
        attachments,
        createdAt: new Date().toISOString(),
      };
      // The thread this turn belongs to. Every state write below is addressed
      // to it, so a reply arriving in another conversation neither clears this
      // one's stream nor gets cleared by it. A lazy create moves the thread
      // onto its real key below; each updater captures the key it meant, since
      // React runs these callbacks after the fact.
      let flightKey = chatFlightKey(convId, newConversationIntent);

      const openingKey = flightKey;
      const openingConvId = convId;
      update(empId, (s) => {
        const isVisibleContext = shouldRenderQueuedMessage(
          openingConvId,
          s.activeConvId,
          newConversationIntent,
          newConversationIntentRef.current[empId] ?? 0,
        );
        return {
          ...s,
          flights: withFlight(s.flights, openingKey, {
            ...(s.flights[openingKey] ?? IDLE_FLIGHT),
            conversationId: openingConvId,
            newConversationIntent,
            sending: true,
            // A new turn is never already being stopped. Without this a flag
            // stranded by an earlier turn would disable this turn's button.
            interrupting: false,
            streamingReply: "",
            progress: null,
            connectionState: "streaming",
          }),
          input: clearInput && isVisibleContext ? "" : s.input,
          messages: isVisibleContext ? [...s.messages, tempUser] : s.messages,
        };
      });

      let accumulated = "";
      let gotAssistant = false;
      let serverEventError = false;
      let persistedUser: ConversationMessage | null = null;
      let workingMessageId: string | null = null;
      let recoverAcceptedTurn: ((initialError: string) => Promise<string | null>) | null = null;

      try {
        // Lazy-create a conversation on first send so never-chatted
        // employees don't accumulate empty threads in the sidebar.
        if (!convId) {
          const created = await api.post<ConversationSummary>(`${base}/conversations`, {});
          convId = created.id;
          // The thread now has a real id, so move its worker, its pending
          // queue, and its flight onto the id-based key in one synchronous
          // step. A follow-up sent before the next render still reads the
          // staged key and lands in the same queue; one sent after reads the
          // real one and finds the worker already there.
          const stagedKey = flightKey;
          const realKey = chatFlightKey(created.id, newConversationIntent);
          flightKey = realKey;
          const stagedPending = pendingKey(empId, stagedKey);
          const realPending = pendingKey(empId, realKey);
          if (stagedPending !== realPending) {
            const queue = pendingRef.current[stagedPending] ?? [];
            delete pendingRef.current[stagedPending];
            pendingRef.current[realPending] = [
              ...(pendingRef.current[realPending] ?? []),
              ...bindLazyCreatedConversation(queue, newConversationIntent, created.id),
            ];
            if (workersRef.current.delete(stagedPending)) workersRef.current.add(realPending);
          }
          flightAliasRef.current[pendingKey(empId, stagedKey)] = {
            flightKey: realKey,
            conversationId: created.id,
          };
          opts?.onConversationCreated?.(created.id);
          const currentIntent = newConversationIntentRef.current[empId] ?? 0;
          update(empId, (s) => {
            const staged = s.flights[stagedKey] ?? IDLE_FLIGHT;
            const flights = { ...s.flights };
            delete flights[stagedKey];
            return {
              ...s,
              convs: [created, ...s.convs.filter((conversation) => conversation.id !== created.id)],
              activeConvId: resolveLazyCreatedSelection(
                currentIntent,
                newConversationIntent,
                s.activeConvId,
                created.id,
              ),
              loadedConvId: resolveLazyCreatedSelection(
                currentIntent,
                newConversationIntent,
                s.loadedConvId,
                created.id,
              ),
              flights: withFlight(flights, realKey, {
                ...staged,
                conversationId: created.id,
                sending: true,
                queuedMessages: bindLazyCreatedConversation(
                  [...(s.flights[realKey]?.queuedMessages ?? []), ...staged.queuedMessages],
                  newConversationIntent,
                  created.id,
                ),
              }),
            };
          });
        }
        // Capture the thread this send belongs to. If the user switches
        // conversation / employee mid-stream, the guards below drop our
        // updates so the wrong thread doesn't get polluted — the server
        // still persists the final message, which the user sees next time
        // they open the conv.
        const streamConvId = convId;

        recoverAcceptedTurn = async (initialError: string): Promise<string | null> => {
          let successfulPolls = 0;
          let failedPolls = 0;
          let accepted = Boolean(persistedUser || workingMessageId);
          update(empId, (s) => markReconnecting(s, streamConvId));

          for (;;) {
            try {
              const detail = await api.get<ConversationDetail>(
                `${base}/conversations/${streamConvId}`,
              );
              successfulPolls += 1;
              failedPolls = 0;
              const turn = findTurnMessages(detail.messages, persistedUser?.id ?? null, tempUser);
              if (turn.user) persistedUser = turn.user;
              const working = turn.assistant?.status === "working" ? turn.assistant : null;
              if (working) {
                accepted = true;
                workingMessageId = working.id;
              }
              if (turn.assistant && turn.assistant.status !== "working") {
                applyConversationDetail(empId, streamConvId, detail);
                return null;
              }
              applyConversationDetail(empId, streamConvId, detail);
              if (!accepted && successfulPolls >= 5) {
                return initialError;
              }
            } catch {
              failedPolls += 1;
              update(empId, (s) => markReconnecting(s, streamConvId));
              if (!accepted && failedPolls >= 60) {
                return initialError;
              }
            }
            await wait(CHAT_RECOVERY_POLL_MS);
          }
        };

        await api.stream(
          `${base}/conversations/${streamConvId}/messages`,
          {
            message: msg,
            attachmentIds: attachments.map((a) => a.id),
            modelId: opts?.modelId ?? null,
          },
          (event, data) => {
            if (event === "user") {
              const userMsg = data as ConversationMessage;
              persistedUser = userMsg;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) => (m.id === tempId ? userMsg : m)),
                };
              });
            } else if (event === "working") {
              const working = data as ConversationMessage;
              workingMessageId = working.id;
              update(empId, (s) => ({
                ...s,
                messages:
                  s.activeConvId === streamConvId ? upsertMessage(s.messages, working) : s.messages,
                flights: patchFlight(s.flights, flightKey, {
                  progress: progressForWorkingMessage(working),
                  connectionState: "streaming",
                }),
              }));
            } else if (event === "chunk") {
              const text = (data as { text?: string } | null)?.text ?? "";
              if (!text) return;
              accumulated += text;
              update(empId, (s) => ({
                ...s,
                flights: patchFlight(s.flights, flightKey, {
                  streamingReply: accumulated,
                  progress: null,
                }),
              }));
            } else if (event === "progress") {
              const candidate = data as Partial<ChatProgress> | null;
              if (
                typeof candidate?.percent !== "number" ||
                !Number.isInteger(candidate.percent) ||
                candidate.percent < 1 ||
                candidate.percent > 99 ||
                typeof candidate.label !== "string" ||
                !candidate.label.trim()
              ) {
                return;
              }
              const progress = {
                percent: candidate.percent,
                label: candidate.label.trim(),
              };
              update(empId, (s) => {
                const flight = s.flights[flightKey];
                if (flight?.streamingReply) return s;
                return {
                  ...s,
                  flights: patchFlight(s.flights, flightKey, {
                    progress,
                    connectionState: "streaming",
                  }),
                  messages:
                    workingMessageId && s.activeConvId === streamConvId
                      ? s.messages.map((message) =>
                          message.id === workingMessageId ? { ...message, progress } : message,
                        )
                      : s.messages,
                };
              });
            } else if (event === "context") {
              const usage = parseContextUsageEvent(data);
              if (!usage) return;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                // This fires once per model step — up to CHAT_MAX_STEPS times
                // in one turn, and during a long tool phase it is the only
                // thing changing. Nothing but `contextUsage` is touched, and
                // even that only when the reading moves: handing back a new
                // `messages` array would retrigger the transcript's
                // scroll-to-bottom effect and repeatedly yank a Member who had
                // scrolled up to re-read something. A reload mid-turn re-reads
                // the persisted row from the server anyway, so a local mirror
                // onto the in-flight message would buy nothing for the cost.
                if (
                  s.contextUsage &&
                  s.contextUsage.tokens === usage.tokens &&
                  s.contextUsage.window === usage.window
                ) {
                  return s;
                }
                return { ...s, contextUsage: usage };
              });
            } else if (event === "assistant") {
              const assistantMsg = data as ConversationMessage;
              workingMessageId = assistantMsg.id;
              gotAssistant = true;
              update(empId, (s) => {
                const flights = patchFlight(s.flights, flightKey, {
                  streamingReply: null,
                  progress: null,
                  connectionState: null,
                });
                if (s.activeConvId !== streamConvId) return { ...s, flights };
                const messages = upsertMessage(s.messages, assistantMsg);
                return {
                  ...s,
                  flights,
                  messages,
                  // The finalized row is authoritative — a mid-turn live event
                  // can be a step behind what the finalize patch wrote. Falling
                  // back to the current reading keeps the badge steady when the
                  // provider reported no usage at all for this turn.
                  contextUsage: latestContextUsage(messages) ?? s.contextUsage,
                };
              });
            } else if (event === "conversation") {
              // Sidebar ordering should reflect the most recently touched
              // thread even if the user is currently viewing a different one.
              const conv = data as ConversationSummary;
              update(empId, (s) => {
                const idx = s.convs.findIndex((c) => c.id === conv.id);
                const next = [...s.convs];
                if (idx >= 0) next.splice(idx, 1);
                return { ...s, convs: [conv, ...next] };
              });
            } else if (event === "error") {
              serverEventError = true;
              throw new Error(
                (data as { message?: string } | null)?.message || "Chat stream failed",
              );
            }
          },
        );

        if (!gotAssistant) {
          return recoverAcceptedTurn("The live response ended before the final reply arrived.");
        }
        return null;
      } catch (err) {
        let raw = (err as Error).message || "Unknown network error";
        if (!serverEventError && convId && recoverAcceptedTurn) {
          const recovered = await recoverAcceptedTurn(raw);
          if (!recovered) return null;
          raw = recovered;
        }
        const m = serverEventError ? raw : formatChatConnectionError(raw);
        update(empId, (s) => {
          const flights = patchFlight(s.flights, flightKey, {
            streamingReply: null,
            progress: null,
            connectionState: null,
          });
          if (
            !shouldRenderQueuedMessage(
              convId,
              s.activeConvId,
              newConversationIntent,
              newConversationIntentRef.current[empId] ?? 0,
            )
          ) {
            return { ...s, flights };
          }
          const userMsg = persistedUser ?? tempUser;
          return {
            ...s,
            flights,
            messages: [
              ...s.messages.filter((x) => x.id !== tempId && x.id !== persistedUser?.id),
              userMsg,
              {
                id: `err-${Date.now()}`,
                conversationId: convId ?? "",
                role: "assistant",
                content: accumulated.trim() ? accumulated + "\n\n" + m : m,
                status: "error",
                createdAt: new Date().toISOString(),
              },
            ],
          };
        });
        return serverEventError
          ? raw
          : "Chat connection interrupted. See the conversation for details.";
      } finally {
        // Only this thread stops sending. Any other conversation with the same
        // employee keeps streaming its own reply.
        update(empId, (s) => {
          const flight = s.flights[flightKey];
          if (!flight) return s;
          return {
            ...s,
            flights: withFlight(s.flights, flightKey, {
              ...flight,
              sending: false,
              interrupting: false,
              streamingReply: null,
              progress: null,
              connectionState: null,
            }),
          };
        });
      }
    },
    [applyConversationDetail, update],
  );

  const send = React.useCallback(
    (
      companyId: string,
      empId: string,
      message: string,
      opts?: {
        clearInput?: boolean;
        attachments?: ChatAttachment[];
        modelId?: string | null;
        interrupt?: boolean;
      },
    ): Promise<string | null> => {
      const content = message.trim();
      const attachments = opts?.attachments ?? [];
      if (!content && attachments.length === 0) {
        return Promise.resolve(null);
      }
      const base = `/api/companies/${companyId}/employees/${empId}`;

      return new Promise<string | null>((resolve) => {
        const intent = newConversationIntentRef.current[empId] ?? 0;
        // A thread whose Conversation was created by its own in-flight first
        // send has already moved key; `sessionsRef` has not caught up yet.
        const staged = sessionsRef.current[empId]?.activeConvId ?? null;
        const alias = staged
          ? undefined
          : flightAliasRef.current[pendingKey(empId, chatFlightKey(null, intent))];
        const conversationId = alias?.conversationId ?? staged;
        const visibleItem: QueuedChatMessage = {
          id: makeQueuedMessageId(),
          conversationId,
          newConversationIntent: intent,
          modelId: opts?.modelId ?? null,
          content,
          attachments,
          queuedAt: new Date().toISOString(),
        };
        const item: PendingChatMessage = { ...visibleItem, resolve };
        // Everything below is scoped to the thread being typed in. A turn
        // running in a *different* conversation with the same employee is that
        // thread's business — this message goes out immediately rather than
        // queueing behind it.
        let flightKey = chatFlightKey(conversationId, intent);
        let queueKey = pendingKey(empId, flightKey);

        /**
         * The Member asked for this message ahead of the reply in flight, so
         * it jumps whatever else is waiting in this thread and the thread's
         * current turn is stopped. A failed stop is not a lost message: it
         * stays at the head of the queue and sends the moment the employee
         * finishes on its own.
         */
        function interruptForThisMessage(): void {
          promoteQueuedMessage(empId, item.id);
          void interruptActiveTurn(companyId, empId, conversationId).then((error) => {
            if (error) console.warn(`[chat] could not stop the reply: ${error}`);
          });
        }

        /** Show this follow-up under its own thread while it waits. */
        function enqueue(): void {
          update(empId, (s) => ({
            ...s,
            input: opts?.clearInput === false ? s.input : "",
            flights: withFlight(s.flights, flightKey, {
              ...(s.flights[flightKey] ?? IDLE_FLIGHT),
              conversationId,
              newConversationIntent: intent,
              queuedMessages: [...(s.flights[flightKey]?.queuedMessages ?? []), visibleItem],
            }),
          }));
        }

        /**
         * Follow the thread onto its real key once a lazy create resolves.
         * `sendTurn` has already moved the worker and the pending queue there.
         */
        function adoptCreatedConversation(createdId: string): void {
          flightKey = chatFlightKey(createdId, intent);
          queueKey = pendingKey(empId, flightKey);
        }

        async function drainQueue(first: PendingChatMessage): Promise<void> {
          let current: PendingChatMessage | undefined = first;
          let firstTurn = true;
          while (current) {
            const error = await sendTurn(companyId, empId, current.content, {
              clearInput: firstTurn ? opts?.clearInput : false,
              attachments: current.attachments,
              conversationId: current.conversationId,
              newConversationIntent: current.newConversationIntent,
              modelId: current.modelId,
              onConversationCreated: adoptCreatedConversation,
            });
            current.resolve(error);
            firstTurn = false;

            const queue = pendingRef.current[queueKey] ?? [];
            current = queue.shift();
            if (current) {
              const nextId = current.id;
              const ownerKey = flightKey;
              update(empId, (s) => {
                const flight = s.flights[ownerKey];
                if (!flight) return s;
                return {
                  ...s,
                  flights: withFlight(s.flights, ownerKey, {
                    ...flight,
                    queuedMessages: flight.queuedMessages.filter((queued) => queued.id !== nextId),
                  }),
                };
              });
            }
          }
          delete pendingRef.current[queueKey];
          workersRef.current.delete(queueKey);
          delete flightAliasRef.current[pendingKey(empId, chatFlightKey(null, intent))];
        }

        if (workersRef.current.has(queueKey)) {
          const queue = pendingRef.current[queueKey] ?? [];
          queue.push(item);
          pendingRef.current[queueKey] = queue;
          enqueue();
          if (opts?.interrupt) interruptForThisMessage();
          return;
        }

        const running = flightFor(sessionsRef.current[empId] ?? EMPTY, conversationId, intent);
        if (running.sending && conversationId) {
          // This thread is already mid-reply — another tab is driving it, or
          // the server recovered it after a restart. Follow it to the end,
          // then drain the follow-ups typed here.
          pendingRef.current[queueKey] = [item];
          workersRef.current.add(queueKey);
          enqueue();
          if (opts?.interrupt) interruptForThisMessage();

          void (async () => {
            for (;;) {
              try {
                const detail = await api.get<ConversationDetail>(
                  `${base}/conversations/${conversationId}`,
                );
                const working = latestWorkingMessage(detail.messages);
                applyConversationDetail(empId, conversationId, detail);
                if (!working) break;
              } catch {
                update(empId, (s) => markReconnecting(s, conversationId));
              }
              await wait(CHAT_RECOVERY_POLL_MS);
            }

            const queue = pendingRef.current[queueKey] ?? [];
            const first = queue.shift();
            if (!first) {
              workersRef.current.delete(queueKey);
              return;
            }
            const firstId = first.id;
            update(empId, (s) => {
              const flight = s.flights[flightKey];
              if (!flight) return s;
              return {
                ...s,
                flights: withFlight(s.flights, flightKey, {
                  ...flight,
                  queuedMessages: flight.queuedMessages.filter((queued) => queued.id !== firstId),
                }),
              };
            });
            await drainQueue(first);
          })();
          return;
        }

        workersRef.current.add(queueKey);
        void drainQueue(item);
      });
    },
    [applyConversationDetail, interruptActiveTurn, promoteQueuedMessage, sendTurn, update],
  );

  const actions = React.useMemo<ChatActions>(
    () => ({
      update,
      initEmployee,
      selectConversation,
      refreshConversation,
      newConversation,
      stageNewConversation,
      claimConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
      removeQueuedMessage,
      promoteQueuedMessage,
      interruptActiveTurn,
    }),
    [
      update,
      initEmployee,
      selectConversation,
      refreshConversation,
      newConversation,
      stageNewConversation,
      claimConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
      removeQueuedMessage,
      promoteQueuedMessage,
      interruptActiveTurn,
    ],
  );

  const value = React.useMemo<ChatSessionsCtx>(() => ({ sessions, actions }), [sessions, actions]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Replace a cached sidebar summary with a freshly-loaded one, in place. Returns
 * the same array when the thread isn't in this list or nothing the UI reads has
 * changed, so the 3s in-flight refresh poll doesn't re-render the sidebar.
 */
function withRefreshedSummary(
  list: ConversationSummary[],
  fresh: ConversationSummary,
): ConversationSummary[] {
  const index = list.findIndex((conversation) => conversation.id === fresh.id);
  if (index === -1) return list;
  const current = list[index];
  if (
    current.title === fresh.title &&
    current.lastModelId === fresh.lastModelId &&
    current.updatedAt === fresh.updatedAt &&
    current.lastMessageAt === fresh.lastMessageAt &&
    current.archivedAt === fresh.archivedAt &&
    current.legacyUnclaimed === fresh.legacyUnclaimed
  ) {
    return list;
  }
  const next = [...list];
  next[index] = fresh;
  return next;
}

function latestWorkingMessage(messages: ConversationMessage[]): ConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.status === "working") {
      return message;
    }
  }
  return null;
}

function progressForWorkingMessage(message: ConversationMessage): ChatProgress {
  const progress = message.progress;
  if (
    progress &&
    Number.isInteger(progress.percent) &&
    progress.percent >= 1 &&
    progress.percent <= 99 &&
    progress.label.trim()
  ) {
    return { percent: progress.percent, label: progress.label.trim() };
  }
  return { percent: 1, label: "Starting work" };
}

function upsertMessage(
  messages: ConversationMessage[],
  incoming: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...messages, incoming];
  const next = [...messages];
  next[index] = incoming;
  return next;
}

function findTurnMessages(
  messages: ConversationMessage[],
  persistedUserId: string | null,
  optimisticUser: ConversationMessage,
): {
  user: ConversationMessage | null;
  assistant: ConversationMessage | null;
} {
  let userIndex = persistedUserId
    ? messages.findIndex((message) => message.id === persistedUserId)
    : -1;
  if (userIndex === -1) {
    const notBefore = Date.parse(optimisticUser.createdAt) - 5 * 60_000;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (
        candidate?.role === "user" &&
        candidate.content === optimisticUser.content &&
        Date.parse(candidate.createdAt) >= notBefore
      ) {
        userIndex = index;
        break;
      }
    }
  }

  if (userIndex === -1) return { user: null, assistant: null };
  const user = messages[userIndex] ?? null;
  const assistant =
    messages.slice(userIndex + 1).find((message) => message.role === "assistant") ?? null;
  return { user, assistant };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatChatConnectionError(detail: string): string {
  const safeDetail = detail.replace(/\s+/g, " ").trim() || "Unknown network error";
  return [
    "The chat connection to Genosyn was interrupted.",
    "",
    `Details: ${safeDetail}`,
    "",
    "Check that the Genosyn server is still running and reachable from this browser. Review the server logs for the underlying error, then reopen this conversation before retrying.",
  ].join("\n");
}

function makeQueuedMessageId(): string {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useChatSessions(): ChatSessionsCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useChatSessions must be used within <ChatSessionsProvider>");
  }
  return ctx;
}

/**
 * Returns the current session for the given employee plus the shared action
 * methods. The session object reference is stable across renders that don't
 * touch this employee's slice.
 */
export function useEmployeeSession(empId: string): {
  session: EmployeeSession;
  actions: ChatActions;
} {
  const { sessions, actions } = useChatSessions();
  return { session: sessions[empId] ?? EMPTY, actions };
}
