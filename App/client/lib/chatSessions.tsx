import React from "react";
import {
  api,
  ChatAttachment,
  ChatProgress,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
} from "./api";

/**
 * Per-employee chat state held at the company-shell level so it survives
 * page navigation. Without this the EmployeeChat component unmounts every
 * time the user clicks Tasks / Settings / Bases mid-conversation, and loses
 * the active thread, the in-progress streaming reply, and any typed-but-
 * unsent text.
 */
export type EmployeeSession = {
  activeConvId: string | null;
  /** Conversation the current `messages` array belongs to. */
  loadedConvId: string | null;
  messages: ConversationMessage[];
  /** Running text for the in-flight assistant reply; null when no stream. */
  streamingReply: string | null;
  /** Latest employee-authored progress update for the in-flight reply. */
  progress: ChatProgress | null;
  /** How this browser is following the durable in-flight turn. */
  connectionState: "streaming" | "polling" | "reconnecting" | null;
  /** Conversation currently receiving the in-flight reply. */
  sendingConvId: string | null;
  sending: boolean;
  /** Follow-up messages waiting for the current reply to finish. */
  queuedMessages: QueuedChatMessage[];
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
  streamingReply: null,
  progress: null,
  connectionState: null,
  sendingConvId: null,
  sending: false,
  queuedMessages: [],
  input: "",
  convs: [],
  archivedConvs: [],
  convsLoaded: false,
  archivedLoaded: false,
  convLoading: false,
}) as EmployeeSession;

type Update = Partial<EmployeeSession> | ((s: EmployeeSession) => EmployeeSession);

type ChatActions = {
  update: (empId: string, u: Update) => void;
  initEmployee: (companyId: string, empId: string) => Promise<void>;
  selectConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  refreshConversation: (companyId: string, empId: string, convId: string) => Promise<void>;
  newConversation: (companyId: string, empId: string) => Promise<void>;
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
    },
  ) => Promise<string | null>;
  removeQueuedMessage: (empId: string, queuedMessageId: string) => void;
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

export function ChatSessionsProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = React.useState<Record<string, EmployeeSession>>({});
  // Ref so async code (stream callbacks, lazy-create paths) can read the
  // current sessions without waiting for a re-render.
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;
  // Synchronous queue state prevents two fast Enter presses from racing a
  // React render. The serializable mirror lives on EmployeeSession for UI.
  const pendingRef = React.useRef<Record<string, PendingChatMessage[]>>({});
  const workersRef = React.useRef(new Set<string>());

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
        if (s.activeConvId !== convId) return s;
        const wasFollowingThisConversation = s.sendingConvId === convId;
        return {
          ...s,
          messages: detail.messages,
          loadedConvId: convId,
          convLoading: false,
          sending: working ? true : wasFollowingThisConversation ? false : s.sending,
          sendingConvId: working ? convId : wasFollowingThisConversation ? null : s.sendingConvId,
          streamingReply: working
            ? s.streamingReply
            : wasFollowingThisConversation
              ? null
              : s.streamingReply,
          progress: working
            ? progressForWorkingMessage(working)
            : wasFollowingThisConversation
              ? null
              : s.progress,
          connectionState: working
            ? connectionState
            : wasFollowingThisConversation
              ? null
              : s.connectionState,
        };
      });
      return working;
    },
    [update],
  );

  const removeQueuedMessage = React.useCallback(
    (empId: string, queuedMessageId: string) => {
      const queue = pendingRef.current[empId] ?? [];
      const index = queue.findIndex((item) => item.id === queuedMessageId);
      if (index === -1) return;
      const [removed] = queue.splice(index, 1);
      removed.resolve(null);
      update(empId, (s) => ({
        ...s,
        queuedMessages: s.queuedMessages.filter((item) => item.id !== queuedMessageId),
      }));
    },
    [update],
  );

  const initEmployee = React.useCallback(
    async (companyId: string, empId: string) => {
      if (sessionsRef.current[empId]?.convsLoaded) return;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const list = await api.get<ConversationSummary[]>(`${base}/conversations`);
      update(empId, (s) => ({
        ...s,
        convs: list,
        convsLoaded: true,
        // Only auto-select the newest thread on first load; returning to
        // this employee later reuses whatever they had selected.
        activeConvId: s.activeConvId ?? list[0]?.id ?? null,
      }));
    },
    [update],
  );

  const selectConversation = React.useCallback(
    async (companyId: string, empId: string, convId: string) => {
      const cur = sessionsRef.current[empId] ?? EMPTY;
      if (cur.loadedConvId === convId && cur.activeConvId === convId) return;
      update(empId, { activeConvId: convId, convLoading: true });
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
        update(empId, (s) => {
          if (s.sendingConvId !== convId) return s;
          return { ...s, connectionState: "reconnecting" };
        });
        throw error;
      }
    },
    [applyConversationDetail, update],
  );

  const newConversation = React.useCallback(
    async (companyId: string, empId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const created = await api.post<ConversationSummary>(`${base}/conversations`, {});
      update(empId, (s) => ({
        ...s,
        convs: [created, ...s.convs],
        activeConvId: created.id,
        loadedConvId: created.id,
        messages: [],
        input: "",
      }));
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
        modelId?: string | null;
      },
    ): Promise<string | null> => {
      const msg = message.trim();
      const attachments = opts?.attachments ?? [];
      if (!msg && attachments.length === 0) return null;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const clearInput = opts?.clearInput ?? true;
      let convId = opts?.conversationId ?? sessionsRef.current[empId]?.activeConvId ?? null;
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

      update(empId, (s) => ({
        ...s,
        sending: true,
        sendingConvId: convId,
        streamingReply: "",
        progress: null,
        connectionState: "streaming",
        input: clearInput ? "" : s.input,
        messages: !convId || s.activeConvId === convId ? [...s.messages, tempUser] : s.messages,
      }));

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
          const queue = pendingRef.current[empId] ?? [];
          for (const pending of queue) {
            if (!pending.conversationId) {
              pending.conversationId = created.id;
            }
          }
          update(empId, (s) => ({
            ...s,
            convs: [created, ...s.convs],
            activeConvId: created.id,
            loadedConvId: created.id,
            sendingConvId: created.id,
            queuedMessages: s.queuedMessages.map((pending) =>
              pending.conversationId ? pending : { ...pending, conversationId: created.id },
            ),
          }));
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
          update(empId, (s) =>
            s.sendingConvId === streamConvId ? { ...s, connectionState: "reconnecting" } : s,
          );

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
              update(empId, (s) =>
                s.sendingConvId === streamConvId ? { ...s, connectionState: "reconnecting" } : s,
              );
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
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  messages: upsertMessage(s.messages, working),
                  progress: progressForWorkingMessage(working),
                  connectionState: "streaming",
                };
              });
            } else if (event === "chunk") {
              const text = (data as { text?: string } | null)?.text ?? "";
              if (!text) return;
              accumulated += text;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  streamingReply: accumulated,
                  progress: null,
                };
              });
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
                if (s.activeConvId !== streamConvId) return s;
                if (s.streamingReply && s.streamingReply.length > 0) return s;
                return {
                  ...s,
                  progress,
                  connectionState: "streaming",
                  messages: workingMessageId
                    ? s.messages.map((message) =>
                        message.id === workingMessageId ? { ...message, progress } : message,
                      )
                    : s.messages,
                };
              });
            } else if (event === "assistant") {
              const assistantMsg = data as ConversationMessage;
              workingMessageId = assistantMsg.id;
              gotAssistant = true;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  messages: upsertMessage(s.messages, assistantMsg),
                  streamingReply: null,
                  progress: null,
                  connectionState: null,
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
          if (s.activeConvId !== convId) {
            return { ...s, streamingReply: null, progress: null };
          }
          const userMsg = persistedUser ?? tempUser;
          return {
            ...s,
            streamingReply: null,
            progress: null,
            connectionState: null,
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
        update(empId, {
          sending: false,
          sendingConvId: null,
          progress: null,
          connectionState: null,
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
      },
    ): Promise<string | null> => {
      const content = message.trim();
      const attachments = opts?.attachments ?? [];
      if (!content && attachments.length === 0) {
        return Promise.resolve(null);
      }
      const base = `/api/companies/${companyId}/employees/${empId}`;

      return new Promise<string | null>((resolve) => {
        const visibleItem: QueuedChatMessage = {
          id: makeQueuedMessageId(),
          conversationId: sessionsRef.current[empId]?.activeConvId ?? null,
          modelId: opts?.modelId ?? null,
          content,
          attachments,
          queuedAt: new Date().toISOString(),
        };
        const item: PendingChatMessage = { ...visibleItem, resolve };

        async function drainQueue(first: PendingChatMessage): Promise<void> {
          let current: PendingChatMessage | undefined = first;
          let firstTurn = true;
          while (current) {
            const error = await sendTurn(companyId, empId, current.content, {
              clearInput: firstTurn ? opts?.clearInput : false,
              attachments: current.attachments,
              conversationId: current.conversationId,
              modelId: current.modelId,
            });
            current.resolve(error);
            firstTurn = false;

            const queue = pendingRef.current[empId] ?? [];
            current = queue.shift();
            if (current) {
              const nextId = current.id;
              update(empId, (s) => ({
                ...s,
                queuedMessages: s.queuedMessages.filter((queued) => queued.id !== nextId),
              }));
            }
          }
          workersRef.current.delete(empId);
        }

        if (workersRef.current.has(empId)) {
          const queue = pendingRef.current[empId] ?? [];
          queue.push(item);
          pendingRef.current[empId] = queue;
          update(empId, (s) => ({
            ...s,
            input: opts?.clearInput === false ? s.input : "",
            queuedMessages: [...s.queuedMessages, visibleItem],
          }));
          return;
        }

        const existing = sessionsRef.current[empId] ?? EMPTY;
        if (existing.sending && existing.sendingConvId) {
          pendingRef.current[empId] = [item];
          workersRef.current.add(empId);
          update(empId, (s) => ({
            ...s,
            input: opts?.clearInput === false ? s.input : "",
            queuedMessages: [...s.queuedMessages, visibleItem],
          }));

          void (async () => {
            const runningConvId = existing.sendingConvId!;
            for (;;) {
              try {
                const detail = await api.get<ConversationDetail>(
                  `${base}/conversations/${runningConvId}`,
                );
                const working = latestWorkingMessage(detail.messages);
                applyConversationDetail(empId, runningConvId, detail);
                if (!working) break;
              } catch {
                update(empId, (s) =>
                  s.sendingConvId === runningConvId ? { ...s, connectionState: "reconnecting" } : s,
                );
              }
              await wait(CHAT_RECOVERY_POLL_MS);
            }

            const queue = pendingRef.current[empId] ?? [];
            const first = queue.shift();
            if (!first) {
              workersRef.current.delete(empId);
              return;
            }
            update(empId, (s) => ({
              ...s,
              queuedMessages: s.queuedMessages.filter((queued) => queued.id !== first.id),
            }));
            await drainQueue(first);
          })();
          return;
        }

        workersRef.current.add(empId);
        void drainQueue(item);
      });
    },
    [applyConversationDetail, sendTurn, update],
  );

  const actions = React.useMemo<ChatActions>(
    () => ({
      update,
      initEmployee,
      selectConversation,
      refreshConversation,
      newConversation,
      claimConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
      removeQueuedMessage,
    }),
    [
      update,
      initEmployee,
      selectConversation,
      refreshConversation,
      newConversation,
      claimConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
      removeQueuedMessage,
    ],
  );

  const value = React.useMemo<ChatSessionsCtx>(() => ({ sessions, actions }), [sessions, actions]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
