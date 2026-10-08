import React from "react";
import { useLiveRefetch } from "@/components/CompanySocket";
import {
  api,
  type ChatProgress,
  type ConversationMessage,
  type ConversationSummary,
  type DecisionDiscussion,
} from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  isWorkingMessage,
  mergeTranscript,
  parseProgress,
  upsertMessage,
} from "@/components/decisions/discussionTranscript";

/** How often a reply this browser is not streaming is re-read until it lands. */
const FOLLOW_POLL_MS = 2_000;

// Which Decisions have their discussion open. Shared rather than held by a
// card, because answering swaps the pending card for its outcome — a
// different component — and the discussion must stay open across that.
const openDiscussions = new Set<string>();
const openListeners = new Set<() => void>();

function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

/** Whether a Decision's discussion is showing, and the switch for it. */
export function useDecisionDiscussionOpen(decisionId: string): [boolean, (open: boolean) => void] {
  const open = React.useSyncExternalStore(
    subscribeOpen,
    () => openDiscussions.has(decisionId),
    () => false,
  );
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openDiscussions.has(decisionId) === next) return;
      if (next) openDiscussions.add(decisionId);
      else openDiscussions.delete(decisionId);
      for (const listener of openListeners) listener();
    },
    [decisionId],
  );
  return [open, setOpen];
}

export type DecisionDiscussionLoad = "loading" | "ready" | "error";

/**
 * A Member's discussion of one Decision, held on the Decision itself.
 *
 * The thread is the server's, not this component's: every turn is persisted
 * as a `working` reply before the employee starts, so a card that unmounts
 * mid-reply — answered, closed, navigated away from — picks the same turn back
 * up by reading it again instead of losing it.
 */
export function useDecisionDiscussion(companyId: string, decisionId: string, employeeId: string) {
  const base = `/api/companies/${companyId}/decisions/${decisionId}/discussion`;
  const [load, setLoad] = React.useState<DecisionDiscussionLoad>("loading");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [conversation, setConversation] = React.useState<ConversationSummary | null>(null);
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [sending, setSending] = React.useState(false);
  /** The reply streaming into this browser, and its live text. */
  const [streamingId, setStreamingId] = React.useState<string | null>(null);
  const [streamingReply, setStreamingReply] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<ChatProgress | null>(null);

  const mounted = React.useRef(true);
  const sendingRef = React.useRef(false);
  const following = React.useRef(false);
  const readVersion = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const conversationRef = React.useRef(conversation);
  conversationRef.current = conversation;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // The turn itself continues on the server; only this stream stops.
      abortRef.current?.abort();
    };
  }, []);

  /** Re-read the thread. Ignored while this browser is streaming a reply. */
  const read = React.useCallback(async (): Promise<DecisionDiscussion | null> => {
    const version = ++readVersion.current;
    try {
      const detail = await api.get<DecisionDiscussion>(base);
      if (!mounted.current || version !== readVersion.current || sendingRef.current) {
        return detail;
      }
      setConversation(detail.conversation);
      setMessages((current) => mergeTranscript(current, detail.messages));
      setLoad("ready");
      setLoadError(null);
      return detail;
    } catch (err) {
      if (mounted.current && version === readVersion.current) {
        // A background re-read that fails keeps the thread on screen; only
        // the first read has nothing else to show.
        setLoad((current) => (current === "ready" ? current : "error"));
        setLoadError(errorMessage(err, "Could not load the discussion"));
      }
      return null;
    }
  }, [base]);

  /** Poll a reply that is being written somewhere other than this stream. */
  const follow = React.useCallback(async () => {
    if (following.current) return;
    following.current = true;
    try {
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, FOLLOW_POLL_MS));
        if (!mounted.current || sendingRef.current) return;
        const detail = await read();
        if (detail && !detail.messages.some(isWorkingMessage)) return;
      }
    } finally {
      following.current = false;
    }
  }, [read]);

  const refresh = React.useCallback(async () => {
    const detail = await read();
    if (detail?.messages.some(isWorkingMessage)) void follow();
  }, [read, follow]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // A turn sent from another tab, or from the employee's chat, shows up here.
  useLiveRefetch(
    "employee_work",
    () => {
      if (!sendingRef.current) void refresh();
    },
    employeeId,
  );

  /**
   * Send one message. Resolves with an error to show beside the composer, or
   * null once the turn was accepted — after that the reply is the server's to
   * finish, and a dropped stream is followed rather than reported as lost.
   */
  const send = React.useCallback(
    async (text: string): Promise<string | null> => {
      const content = text.trim();
      if (!content || sendingRef.current) return null;
      sendingRef.current = true;
      setSending(true);
      setStreamingId(null);
      setStreamingReply(null);
      setProgress(null);
      const pendingId = `pending-${Date.now()}`;
      setMessages((current) => [
        ...current,
        {
          id: pendingId,
          conversationId: conversationRef.current?.id ?? "",
          role: "user",
          content,
          status: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      const controller = new AbortController();
      abortRef.current = controller;
      let accepted = false;
      let finished = false;
      try {
        let thread = conversationRef.current;
        if (!thread) {
          // The thread is created on the first send, so opening a discussion
          // and changing your mind leaves nothing behind.
          const opened = await api.post<DecisionDiscussion>(base, {});
          if (!opened.conversation) throw new Error("Could not open the discussion");
          thread = opened.conversation;
          conversationRef.current = thread;
          if (mounted.current) {
            setConversation(thread);
            setLoad("ready");
            setLoadError(null);
            // Another tab may have started this thread already.
            setMessages((current) => [
              ...opened.messages.filter((row) => !current.some((mine) => mine.id === row.id)),
              ...current,
            ]);
          }
        }
        await api.stream(
          `/api/companies/${companyId}/employees/${thread.employeeId}/conversations/${thread.id}/messages`,
          { message: content, attachmentIds: [], modelId: null },
          (event, data) => {
            if (event === "error") {
              throw new Error(
                (data as { message?: string } | null)?.message || "Could not send your message",
              );
            }
            if (!mounted.current) return;
            if (event === "user") {
              accepted = true;
              const row = data as ConversationMessage;
              setMessages((current) =>
                current.map((message) => (message.id === pendingId ? row : message)),
              );
            } else if (event === "working") {
              accepted = true;
              const row = data as ConversationMessage;
              setStreamingId(row.id);
              setMessages((current) => upsertMessage(current, row));
            } else if (event === "chunk") {
              const piece = (data as { text?: string } | null)?.text ?? "";
              if (piece) setStreamingReply((current) => (current ?? "") + piece);
            } else if (event === "progress") {
              const next = parseProgress(data);
              if (next) setProgress(next);
            } else if (event === "assistant") {
              finished = true;
              setMessages((current) => upsertMessage(current, data as ConversationMessage));
              setStreamingId(null);
              setStreamingReply(null);
              setProgress(null);
            } else if (event === "conversation") {
              setConversation(data as ConversationSummary);
            }
          },
          { signal: controller.signal },
        );
        return null;
      } catch (err) {
        if (accepted || controller.signal.aborted) return null;
        if (mounted.current) {
          setMessages((current) => current.filter((message) => message.id !== pendingId));
        }
        return errorMessage(err, "Could not send your message");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        sendingRef.current = false;
        if (mounted.current) {
          setSending(false);
          setStreamingId(null);
          setStreamingReply(null);
          setProgress(null);
          // The stream ended before the reply did: the durable turn finishes
          // on the server, so read it back until it lands.
          if (accepted && !finished) void refresh();
        }
      }
    },
    [base, companyId, refresh],
  );

  const replying = sending || messages.some(isWorkingMessage);

  return {
    load,
    loadError,
    conversation,
    messages,
    sending,
    replying,
    streamingId,
    streamingReply,
    progress,
    send,
    retry: refresh,
  };
}
