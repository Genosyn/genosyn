import React from "react";
import {
  api,
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
  sending: boolean;
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

const EMPTY: EmployeeSession = Object.freeze({
  activeConvId: null,
  loadedConvId: null,
  messages: [],
  streamingReply: null,
  sending: false,
  input: "",
  convs: [],
  archivedConvs: [],
  convsLoaded: false,
  archivedLoaded: false,
  convLoading: false,
}) as EmployeeSession;

type Update =
  | Partial<EmployeeSession>
  | ((s: EmployeeSession) => EmployeeSession);

type ChatActions = {
  update: (empId: string, u: Update) => void;
  initEmployee: (companyId: string, empId: string) => Promise<void>;
  selectConversation: (
    companyId: string,
    empId: string,
    convId: string,
  ) => Promise<void>;
  newConversation: (companyId: string, empId: string) => Promise<void>;
  deleteConversation: (
    companyId: string,
    empId: string,
    convId: string,
  ) => Promise<void>;
  archiveConversation: (
    companyId: string,
    empId: string,
    convId: string,
  ) => Promise<void>;
  unarchiveConversation: (
    companyId: string,
    empId: string,
    convId: string,
  ) => Promise<void>;
  loadArchived: (companyId: string, empId: string) => Promise<void>;
  /** Resolves with an error message on failure, or null on success. */
  send: (
    companyId: string,
    empId: string,
    message: string,
    opts?: { clearInput?: boolean },
  ) => Promise<string | null>;
};

type ChatSessionsCtx = {
  sessions: Record<string, EmployeeSession>;
  actions: ChatActions;
};

const Ctx = React.createContext<ChatSessionsCtx | null>(null);

export function ChatSessionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sessions, setSessions] = React.useState<
    Record<string, EmployeeSession>
  >({});
  // Ref so async code (stream callbacks, lazy-create paths) can read the
  // current sessions without waiting for a re-render.
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;

  const update = React.useCallback((empId: string, u: Update) => {
    setSessions((prev) => {
      const cur = prev[empId] ?? EMPTY;
      const next = typeof u === "function" ? u(cur) : { ...cur, ...u };
      if (next === cur) return prev;
      return { ...prev, [empId]: next };
    });
  }, []);

  const initEmployee = React.useCallback(
    async (companyId: string, empId: string) => {
      if (sessionsRef.current[empId]?.convsLoaded) return;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const list = await api.get<ConversationSummary[]>(
        `${base}/conversations`,
      );
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
        const detail = await api.get<ConversationDetail>(
          `${base}/conversations/${convId}`,
        );
        // Drop the response if the user switched away before it returned.
        if (sessionsRef.current[empId]?.activeConvId !== convId) return;
        update(empId, {
          messages: detail.messages,
          loadedConvId: convId,
          convLoading: false,
        });
      } catch (err) {
        if (sessionsRef.current[empId]?.activeConvId === convId) {
          update(empId, { convLoading: false });
        }
        throw err;
      }
    },
    [update],
  );

  const newConversation = React.useCallback(
    async (companyId: string, empId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const created = await api.post<ConversationSummary>(
        `${base}/conversations`,
        {},
      );
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

  const loadArchived = React.useCallback(
    async (companyId: string, empId: string) => {
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const list = await api.get<ConversationSummary[]>(
        `${base}/conversations?archived=1`,
      );
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
          archivedConvs: [
            updated,
            ...s.archivedConvs.filter((c) => c.id !== convId),
          ],
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

  const send = React.useCallback(
    async (
      companyId: string,
      empId: string,
      message: string,
      opts?: { clearInput?: boolean },
    ): Promise<string | null> => {
      const msg = message.trim();
      if (!msg) return null;
      const base = `/api/companies/${companyId}/employees/${empId}`;
      const clearInput = opts?.clearInput ?? true;
      const tempId = `temp-${Date.now()}`;
      const tempUser: ConversationMessage = {
        id: tempId,
        conversationId: "",
        role: "user",
        content: msg,
        status: null,
        createdAt: new Date().toISOString(),
      };

      update(empId, (s) => ({
        ...s,
        sending: true,
        streamingReply: "",
        input: clearInput ? "" : s.input,
        messages: [...s.messages, tempUser],
      }));

      let accumulated = "";
      let gotAssistant = false;
      let convId = sessionsRef.current[empId]?.activeConvId ?? null;

      try {
        // Lazy-create a conversation on first send so never-chatted
        // employees don't accumulate empty threads in the sidebar.
        if (!convId) {
          const created = await api.post<ConversationSummary>(
            `${base}/conversations`,
            {},
          );
          convId = created.id;
          update(empId, (s) => ({
            ...s,
            convs: [created, ...s.convs],
            activeConvId: created.id,
            loadedConvId: created.id,
          }));
        }
        // Capture the thread this send belongs to. If the user switches
        // conversation / employee mid-stream, the guards below drop our
        // updates so the wrong thread doesn't get polluted — the server
        // still persists the final message, which the user sees next time
        // they open the conv.
        const streamConvId = convId;

        await api.stream(
          `${base}/conversations/${streamConvId}/messages`,
          { message: msg },
          (event, data) => {
            if (event === "user") {
              const userMsg = data as ConversationMessage;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === tempId ? userMsg : m,
                  ),
                };
              });
            } else if (event === "chunk") {
              const text = (data as { text?: string } | null)?.text ?? "";
              accumulated += text;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return { ...s, streamingReply: accumulated };
              });
            } else if (event === "assistant") {
              const assistantMsg = data as ConversationMessage;
              gotAssistant = true;
              update(empId, (s) => {
                if (s.activeConvId !== streamConvId) return s;
                return {
                  ...s,
                  messages: [...s.messages, assistantMsg],
                  streamingReply: null,
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
              throw new Error(
                (data as { message?: string } | null)?.message ||
                  "Chat stream failed",
              );
            }
          },
        );

        if (!gotAssistant) {
          update(empId, (s) => {
            if (s.activeConvId !== streamConvId) return s;
            return {
              ...s,
              streamingReply: null,
              messages: [
                ...s.messages,
                {
                  id: `local-${Date.now()}`,
                  conversationId: streamConvId,
                  role: "assistant",
                  content: accumulated.trim() || "(no reply)",
                  status: accumulated.trim() ? "ok" : "error",
                  createdAt: new Date().toISOString(),
                },
              ],
            };
          });
        }
        return null;
      } catch (err) {
        const m = (err as Error).message;
        update(empId, (s) => {
          if (s.activeConvId !== convId) {
            return { ...s, streamingReply: null };
          }
          return {
            ...s,
            streamingReply: null,
            messages: [
              ...s.messages.filter((x) => x.id !== tempId),
              tempUser,
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
        return m;
      } finally {
        update(empId, { sending: false });
      }
    },
    [update],
  );

  const actions = React.useMemo<ChatActions>(
    () => ({
      update,
      initEmployee,
      selectConversation,
      newConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
    }),
    [
      update,
      initEmployee,
      selectConversation,
      newConversation,
      deleteConversation,
      archiveConversation,
      unarchiveConversation,
      loadArchived,
      send,
    ],
  );

  const value = React.useMemo<ChatSessionsCtx>(
    () => ({ sessions, actions }),
    [sessions, actions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatSessions(): ChatSessionsCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useChatSessions must be used within <ChatSessionsProvider>",
    );
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
