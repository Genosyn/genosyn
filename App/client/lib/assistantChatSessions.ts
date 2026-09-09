import React from "react";
import type { ChatAttachment } from "@/lib/api";

export type AssistantChatTarget = { id: string; name: string; slug: string };

export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant";
  employeeId: string | null;
  content: string;
  status: "working" | "ok" | "skipped" | "error" | null;
  attachments: ChatAttachment[];
};

/** A follow-up owns its files, employee, model and focused draft at submission. */
export type AssistantQueuedMessage = {
  id: string;
  message: string;
  attachments: ChatAttachment[];
  employeeId?: string;
  modelId?: string | null;
  focusedMessageId?: string | null;
  queuedAt: string;
};

export type AssistantChatBootstrap<M, R> = {
  messages: M[];
  roster: R[];
  modelId: string | null;
};

export type AssistantChatAdapter<M extends AssistantChatMessage, R> = {
  load: () => Promise<AssistantChatBootstrap<M, R>>;
  send: (
    item: AssistantQueuedMessage,
    onEvent: (event: string, data: unknown) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  clear: () => Promise<unknown>;
  createUserMessage: (item: AssistantQueuedMessage) => M;
  initialTarget?: (result: AssistantChatBootstrap<M, R>) => AssistantChatTarget | null;
};

export type AssistantChatState<M, R> = {
  messages: M[] | null;
  roster: R[];
  target: AssistantChatTarget | null;
  modelId: string | null;
  streaming: string | null;
  /** An owned turn is still being submitted or followed, even without SSE. */
  streamOpen: boolean;
  reconnecting: boolean;
  loading: boolean;
  loadError: string | null;
  queuedMessages: AssistantQueuedMessage[];
  queuePaused: string | null;
};

type SubmitInput = Omit<AssistantQueuedMessage, "id" | "queuedAt">;

const POLL_MS = 2_000;
const MAX_IDLE_SESSIONS = 40;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not reach Genosyn.";
}

function upsert<M extends AssistantChatMessage>(messages: M[] | null, row: M): M[] {
  const previous = messages ?? [];
  const index = previous.findIndex((message) => message.id === row.id);
  if (index === -1) return [...previous, row];
  return previous.map((message, i) => (i === index ? row : message));
}

/**
 * One session, independent of the panel displaying it. Keeping the worker
 * outside React lets a follow-up finish in its original email or Routine
 * when the Member closes the panel or opens another conversation.
 *
 * Waiting messages stay in this browser session, like employee-chat queues;
 * only submitted turns are persisted by the server. Never retry an uncertain
 * POST automatically: first recover its persisted user/assistant rows.
 */
export class AssistantChatSession<M extends AssistantChatMessage, R> {
  private state: AssistantChatState<M, R> = {
    messages: null,
    roster: [],
    target: null,
    modelId: null,
    streaming: null,
    streamOpen: false,
    reconnecting: false,
    loading: true,
    loadError: null,
    queuedMessages: [],
    queuePaused: null,
  };
  private listeners = new Set<() => void>();
  private loadPromise: Promise<AssistantChatBootstrap<M, R>> | null = null;
  private worker = false;
  private clearing = false;
  private disposed = false;
  private openPanels = 0;
  private targetVersion = 0;
  private modelVersion = 0;
  private queuedTargetVersions = new Map<string, number>();
  private messageRevision = 0;
  private messageChanges = new Map<string, number>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private optimisticId: string | null = null;

  constructor(
    private adapter: AssistantChatAdapter<M, R>,
    private readonly pollMs = POLL_MS,
  ) {}

  getSnapshot = (): AssistantChatState<M, R> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setAdapter(adapter: AssistantChatAdapter<M, R>): void {
    this.adapter = adapter;
  }
  private patch(patch: Partial<AssistantChatState<M, R>>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  setTarget = (target: AssistantChatTarget | null): void => {
    this.targetVersion += 1;
    this.patch({ target });
  };
  setModelId = (modelId: string | null): void => {
    this.modelVersion += 1;
    this.patch({ modelId });
  };
  updateMessage = (row: M): void => {
    this.messageChanges.set(row.id, ++this.messageRevision);
    this.patch({ messages: upsert(this.state.messages, row) });
  };

  /** Refresh an idle conversation on return; an active worker already follows it. */
  open = (): (() => void) => {
    this.openPanels += 1;
    if (this.openPanels === 1 && !this.worker && !this.clearing) {
      void this.load().then(
        () => this.kick(),
        () => undefined,
      );
    }
    return () => {
      this.openPanels -= 1;
    };
  };

  private async load(): Promise<AssistantChatBootstrap<M, R>> {
    if (this.loadPromise) return this.loadPromise;
    const targetVersion = this.targetVersion;
    const modelVersion = this.modelVersion;
    const messageRevision = this.messageRevision;
    const adapter = this.adapter;
    if (!this.worker || this.state.messages === null) this.patch({ loading: true });
    this.loadPromise = adapter
      .load()
      .then(
        (result) => {
          const newer = new Map(
            (this.state.messages ?? [])
              .filter(
                (message) =>
                  message.id === this.optimisticId ||
                  (this.messageChanges.get(message.id) ?? 0) > messageRevision,
              )
              .map((message) => [message.id, message]),
          );
          const messages = result.messages.map((message) => newer.get(message.id) ?? message);
          const known = new Set(messages.map((message) => message.id));
          messages.push(...[...newer.values()].filter((message) => !known.has(message.id)));
          this.patch({
            messages,
            roster: result.roster,
            loading: false,
            loadError: null,
            ...(this.targetVersion === targetVersion && this.targetVersion === 0
              ? { target: adapter.initialTarget?.(result) ?? this.state.target }
              : {}),
            ...(this.modelVersion === modelVersion && this.modelVersion === 0
              ? { modelId: result.modelId }
              : {}),
          });
          // Callers recovering acceptance must inspect only server rows,
          // never mistake the preserved optimistic bubble for a receipt.
          return result;
        },
        (error: unknown) => {
          this.patch({ loading: false, loadError: failureMessage(error) });
          throw error;
        },
      )
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  send = (input: SubmitInput): void => this.enqueue(input, false);
  /** A failed predecessor must be retried before the follow-ups waiting on it. */
  retry = (input: SubmitInput): void => this.enqueue(input, true);
  private enqueue(input: SubmitInput, first: boolean): void {
    const message = input.message.trim();
    if ((!message && input.attachments.length === 0) || this.disposed) return;
    if (this.clearing) throw new Error("Wait for the new context to finish opening.");
    const item: AssistantQueuedMessage = {
      ...input,
      message,
      attachments: input.attachments.map((attachment) => ({ ...attachment })),
      // Local display identity only; self-hosted HTTP pages need not expose
      // the secure-context-only crypto.randomUUID browser API.
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      queuedAt: new Date().toISOString(),
    };
    // A retry belongs to its failed turn; it does not change a new draft's
    // selected employee. Ordinary messages may update only the selection
    // that was current when the Member put them in the queue.
    this.queuedTargetVersions.set(item.id, first ? -1 : this.targetVersion);
    this.patch({
      queuedMessages: first
        ? [item, ...this.state.queuedMessages]
        : [...this.state.queuedMessages, item],
      // With nothing waiting, a deliberately submitted new message already
      // expresses the Member's choice to continue after a failed reply.
      ...(first || this.state.queuedMessages.length === 0 ? { queuePaused: null } : {}),
    });
    this.kick();
  }
  removeQueuedMessage = (id: string): void => {
    this.queuedTargetVersions.delete(id);
    this.patch({ queuedMessages: this.state.queuedMessages.filter((item) => item.id !== id) });
  };
  resumeQueue = (): void => {
    this.patch({ queuePaused: null });
    this.kick();
  };

  clear = async (): Promise<void> => {
    if (
      this.worker ||
      this.clearing ||
      this.loadPromise ||
      this.state.loading ||
      this.state.streamOpen ||
      this.state.queuedMessages.length > 0 ||
      this.workingMessage()
    ) {
      throw new Error(
        "Wait for the current reply and remove queued messages before starting a new context.",
      );
    }
    this.clearing = true;
    try {
      await this.adapter.clear();
      this.targetVersion = 0;
      this.modelVersion = 0;
      this.messageChanges.clear();
      this.patch({ messages: [], target: null, modelId: null, queuePaused: null });
    } finally {
      this.clearing = false;
    }
  };

  private workingMessage(): M | undefined {
    return this.state.messages?.find((row) => row.role === "assistant" && row.status === "working");
  }
  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, this.pollMs);
    });
  }
  private kick(): void {
    if (this.worker || this.disposed || this.clearing || this.state.queuePaused) return;
    this.worker = true;
    void this.drain()
      .catch((error: unknown) => {
        this.patch({ queuePaused: failureMessage(error), streamOpen: false, reconnecting: false });
      })
      .finally(() => {
        this.worker = false;
        if (!this.disposed && !this.state.queuePaused && this.state.queuedMessages.length > 0) {
          this.kick();
        }
      });
  }
  private async drain(): Promise<void> {
    while (!this.disposed && !this.state.queuePaused) {
      if (
        this.loadPromise ||
        this.state.loading ||
        this.state.messages === null ||
        this.workingMessage()
      ) {
        const followedId = this.workingMessage()?.id;
        try {
          await this.load();
          if (this.disposed) return;
          this.patch({ reconnecting: false });
          const followed = this.state.messages?.find((row) => row.id === followedId);
          if (followed && (followed.status === "error" || followed.status === "skipped")) {
            this.pauseAfterReply();
            return;
          }
          if (this.workingMessage()) {
            await this.wait();
            continue;
          }
        } catch {
          this.patch({ reconnecting: true });
          await this.wait();
          continue;
        }
      }
      const [next, ...queuedMessages] = this.state.queuedMessages;
      if (!next) return;
      this.patch({ queuedMessages, streamOpen: true, streaming: null, reconnecting: false });
      await this.sendTurn(next);
    }
  }

  private pauseAfterReply(): void {
    this.patch({
      queuePaused:
        "The last reply did not finish successfully. Review it, then continue your queued messages when ready.",
    });
  }

  private async sendTurn(item: AssistantQueuedMessage): Promise<void> {
    const adapter = this.adapter;
    const baseline = new Set((this.state.messages ?? []).map((row) => row.id));
    const targetVersion = this.queuedTargetVersions.get(item.id);
    const temp = adapter.createUserMessage(item);
    this.optimisticId = temp.id;
    this.updateMessage(temp);
    let userId: string | null = null;
    let workingId: string | null = null;
    let terminal: M | null = null;
    let requestError: unknown;
    let explicitError = false;
    let accumulated = "";
    const controller = new AbortController();
    this.controller = controller;
    try {
      await adapter.send(
        item,
        (event, data) => {
          if (this.disposed) return;
          if (event === "user") {
            const row = data as M;
            userId = row.id;
            this.optimisticId = null;
            this.patch({ messages: (this.state.messages ?? []).filter((m) => m.id !== temp.id) });
            this.updateMessage(row);
          } else if (event === "target") {
            if (this.targetVersion === targetVersion) {
              this.patch({ target: (data as { employee: AssistantChatTarget | null }).employee });
            }
          } else if (event === "working") {
            const row = data as M;
            workingId = row.id;
            this.updateMessage(row);
          } else if (event === "chunk") {
            accumulated += (data as { text: string }).text;
            this.patch({ streaming: accumulated });
          } else if (event === "assistant") {
            terminal = data as M;
            this.updateMessage(terminal);
            this.patch({ streaming: null });
          } else if (event === "error") {
            explicitError = true;
            throw new Error((data as { message: string }).message);
          }
        },
        controller.signal,
      );
    } catch (error) {
      requestError = error;
    }

    // The HTTP reader can finish without a final event (including a clean
    // truncated SSE response). Recover before allowing the next POST.
    while (!terminal && !this.disposed) {
      this.patch({ reconnecting: true });
      try {
        const result = await this.load();
        if (this.disposed) return;
        if (!userId) {
          const candidates = result.messages.filter(
            (row) =>
              !baseline.has(row.id) &&
              row.role === "user" &&
              row.content === item.message &&
              row.attachments.length === item.attachments.length &&
              row.attachments.every((attachment) =>
                item.attachments.some((a) => a.id === attachment.id),
              ),
          );
          if (candidates.length === 1) userId = candidates[0].id;
        }
        if (userId) {
          this.optimisticId = null;
          this.patch({ messages: result.messages });
        }
        if (workingId) {
          const row = result.messages.find((message) => message.id === workingId);
          if (row && row.status !== "working") terminal = row;
        } else if (userId) {
          const index = result.messages.findIndex((row) => row.id === userId);
          // No request id is exposed by these panels. Only adopt the next
          // reply when no intervening Member message makes ownership unclear.
          const reply = index >= 0 ? result.messages[index + 1] : undefined;
          if (reply?.role === "assistant" && !baseline.has(reply.id)) {
            if (reply.status === "working") workingId = reply.id;
            else terminal = reply;
          }
        }
        if (!terminal && !workingId && !userId) {
          // Even an authoritative empty read cannot prove a dropped request
          // will never arrive. Preserve the draft and require a deliberate
          // continuation; never silently re-submit it or drain its followers.
          this.optimisticId = null;
          this.patch({
            messages: result.messages,
            queuedMessages: [item, ...this.state.queuedMessages],
            queuePaused: explicitError
              ? `Genosyn could not start this message: ${failureMessage(requestError)} Review it before continuing the queue.`
              : "The connection ended before Genosyn confirmed this message. Review the conversation before continuing the queue to avoid repeating work.",
          });
          break;
        }
        if (!terminal && explicitError && userId && !workingId) {
          this.patch({
            queuePaused: `Your message was saved, but the reply could not start: ${failureMessage(requestError)}`,
          });
          break;
        }
      } catch {
        // A server outage is not proof the request failed. Keep all later
        // messages waiting until a successful read tells us what happened.
      }
      if (!terminal && !this.state.queuePaused) await this.wait();
    }
    if (this.disposed) return;
    if (!this.state.queuedMessages.some((queued) => queued.id === item.id)) {
      this.queuedTargetVersions.delete(item.id);
    }
    if (terminal && (terminal.status === "error" || terminal.status === "skipped")) {
      this.pauseAfterReply();
    }
    this.controller = null;
    this.patch({ streamOpen: false, streaming: null, reconnecting: false });
  }

  /** Auth reset stops local subscribers and drops unsent follow-ups. */
  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.wake?.();
    this.listeners.clear();
  }
  get idle(): boolean {
    return (
      this.openPanels === 0 &&
      !this.worker &&
      !this.clearing &&
      this.state.queuedMessages.length === 0
    );
  }
}

const sessions = new Map<string, AssistantChatSession<AssistantChatMessage, unknown>>();

export function clearAssistantChatSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}

export function useAssistantChatSession<M extends AssistantChatMessage, R>(
  scopeKey: string,
  adapter: AssistantChatAdapter<M, R>,
) {
  let session = sessions.get(scopeKey) as AssistantChatSession<M, R> | undefined;
  if (!session) {
    for (const [key, entry] of sessions) {
      if (sessions.size < MAX_IDLE_SESSIONS) break;
      if (entry.idle) {
        entry.dispose();
        sessions.delete(key);
      }
    }
    session = new AssistantChatSession(adapter);
    sessions.set(
      scopeKey,
      session as unknown as AssistantChatSession<AssistantChatMessage, unknown>,
    );
  }
  session.setAdapter(adapter);
  const state = React.useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const current = session;
  React.useEffect(() => current.open(), [current]);
  return {
    ...state,
    send: session.send,
    retry: session.retry,
    clear: session.clear,
    updateMessage: session.updateMessage,
    setTarget: session.setTarget,
    setModelId: session.setModelId,
    removeQueuedMessage: session.removeQueuedMessage,
    resumeQueue: session.resumeQueue,
  };
}
