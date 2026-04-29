import { api, Notification } from "./api";

/**
 * Client-side types + API helpers + WebSocket client for the workspace-chat
 * surface. Types here intentionally mirror the server's DTOs in
 * `services/workspaceChat.ts` so a grep for a field name finds both halves.
 */

export type WorkspaceAuthorKind = "user" | "ai" | "system";
export type WorkspaceChannelKind = "public" | "private" | "dm";

export type WorkspaceAuthor =
  | { kind: "user"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | { kind: "system"; id: null; name: string };

export type WorkspaceAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export type WorkspaceReaction = {
  emoji: string;
  count: number;
  byMe: boolean;
  actors: { kind: "user" | "ai"; id: string; name: string }[];
};

export type WorkspaceMessage = {
  id: string;
  channelId: string;
  authorKind: WorkspaceAuthorKind;
  author: WorkspaceAuthor | null;
  content: string;
  parentMessageId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: WorkspaceAttachment[];
  reactions: WorkspaceReaction[];
};

export type WorkspaceChannel = {
  id: string;
  companyId: string;
  kind: WorkspaceChannelKind;
  name: string | null;
  slug: string | null;
  topic: string;
  archivedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  members: WorkspaceAuthor[];
  unreadCount: number;
};

export type WorkspaceDirectory = {
  members: {
    id: string;
    name: string;
    email: string;
    handle: string | null;
  }[];
  employees: { id: string; name: string; slug: string; role: string }[];
};

/**
 * A single @-mentionable thing in the company — user, AI employee, channel,
 * base, base table, or connection. The client filters this flat list by
 * handle prefix as the user types. `href` is the relative URL the clickable
 * pill in a rendered message should navigate to.
 */
export type Mentionable = {
  kind: "user" | "ai" | "base" | "base_table" | "connection" | "channel";
  handle: string;
  label: string;
  sublabel?: string;
  href: string;
};

// ──────────────────────── REST wrappers ──────────────────────────────────

const base = (companyId: string) => `/api/companies/${companyId}/workspace`;

export const workspaceApi = {
  directory: (companyId: string) =>
    api.get<WorkspaceDirectory>(`${base(companyId)}/directory`),

  mentionables: (companyId: string) =>
    api.get<Mentionable[]>(`${base(companyId)}/mentionables`),

  listChannels: (companyId: string) =>
    api.get<WorkspaceChannel[]>(`${base(companyId)}/channels`),

  getChannel: (companyId: string, channelId: string) =>
    api.get<WorkspaceChannel>(`${base(companyId)}/channels/${channelId}`),

  createChannel: (
    companyId: string,
    body: {
      name: string;
      topic?: string;
      kind?: "public" | "private";
      memberUserIds?: string[];
      employeeIds?: string[];
    },
  ) => api.post<WorkspaceChannel>(`${base(companyId)}/channels`, body),

  archiveChannel: (companyId: string, channelId: string) =>
    api.post(`${base(companyId)}/channels/${channelId}/archive`),

  addMembers: (
    companyId: string,
    channelId: string,
    body: { userIds?: string[]; employeeIds?: string[] },
  ) =>
    api.post<WorkspaceChannel>(
      `${base(companyId)}/channels/${channelId}/members`,
      body,
    ),

  markRead: (companyId: string, channelId: string) =>
    api.post(`${base(companyId)}/channels/${channelId}/read`),

  openDm: (
    companyId: string,
    target: { targetUserId: string } | { targetEmployeeId: string },
  ) => api.post<WorkspaceChannel>(`${base(companyId)}/dms`, target),

  listMessages: (
    companyId: string,
    channelId: string,
    opts: { before?: string; limit?: number } = {},
  ) => {
    const p = new URLSearchParams();
    if (opts.before) p.set("before", opts.before);
    if (opts.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    return api.get<WorkspaceMessage[]>(
      `${base(companyId)}/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
    );
  },

  sendMessage: (
    companyId: string,
    channelId: string,
    body: { content: string; attachmentIds?: string[]; parentMessageId?: string | null },
  ) =>
    api.post<WorkspaceMessage>(
      `${base(companyId)}/channels/${channelId}/messages`,
      body,
    ),

  editMessage: (companyId: string, messageId: string, content: string) =>
    api.patch<WorkspaceMessage>(
      `${base(companyId)}/messages/${messageId}`,
      { content },
    ),

  deleteMessage: (companyId: string, messageId: string) =>
    api.del(`${base(companyId)}/messages/${messageId}`),

  toggleReaction: (companyId: string, messageId: string, emoji: string) =>
    api.post<{ added: boolean }>(
      `${base(companyId)}/messages/${messageId}/reactions`,
      { emoji },
    ),

  uploadAttachment: async (
    companyId: string,
    file: File,
  ): Promise<WorkspaceAttachment> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${base(companyId)}/attachments`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || res.statusText);
    }
    return res.json();
  },

  attachmentUrl: (companyId: string, attachmentId: string) =>
    `${base(companyId)}/attachments/${attachmentId}`,

  wsToken: (companyId: string) =>
    api.post<{ token: string }>(`${base(companyId)}/ws-token`),
};

// ──────────────────────── WebSocket client ───────────────────────────────

export type WsInboundEvent =
  | { type: "hello"; userId: string; companyId: string }
  | { type: "message.new"; channelId: string; message: WorkspaceMessage }
  | {
      type: "message.edit";
      channelId: string;
      messageId: string;
      content: string;
      editedAt: string;
    }
  | { type: "message.delete"; channelId: string; messageId: string }
  | {
      type: "reaction.add";
      channelId: string;
      messageId: string;
      emoji: string;
      by: { kind: "user" | "ai"; id: string; name: string };
    }
  | {
      type: "reaction.remove";
      channelId: string;
      messageId: string;
      emoji: string;
      by: { kind: "user" | "ai"; id: string };
    }
  | { type: "channel.new"; channel: WorkspaceChannel }
  | { type: "channel.update"; channelId: string; channel: WorkspaceChannel }
  | { type: "channel.archive"; channelId: string }
  | {
      type: "typing";
      channelId: string;
      by: { kind: "user" | "ai"; id: string; name: string };
    }
  | { type: "presence"; userId: string; online: boolean }
  | {
      type: "notification.new";
      userId: string;
      notification: Notification;
    }
  | {
      type: "notification.read";
      userId: string;
      notificationIds: string[];
    };

export type CompanySocket = {
  close: () => void;
  sendTyping: (channelId: string, name: string) => void;
  /** Register a handler. Returns an unsubscribe function. */
  subscribe: (handler: (event: WsInboundEvent) => void) => () => void;
};

/** Backwards-compat alias for the chat surface that was the first consumer. */
export type WorkspaceSocket = CompanySocket;

/**
 * Open an authenticated WebSocket for the given company. One physical
 * connection is shared by every consumer in the page (workspace chat,
 * notifications, etc.) via the `subscribe` fan-out — opening N sockets
 * for N features would burn server slots and double-deliver messages.
 *
 * Auth is a two-step mint: we first call POST /ws-token to get a short-
 * lived token, then upgrade with `?token=...`. The socket auto-reconnects
 * with exponential backoff up to 30 s and re-mints the token each attempt.
 */
export function connectCompanySocket(
  companyId: string,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
): CompanySocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const handlers = new Set<(event: WsInboundEvent) => void>();

  function dispatch(event: WsInboundEvent) {
    // Snapshot so a handler that unsubscribes mid-iteration doesn't skip
    // its peers.
    for (const fn of Array.from(handlers)) {
      try {
        fn(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ws] handler threw:", err);
      }
    }
  }

  async function open() {
    if (closed) return;
    onStatus?.("connecting");
    let token: string;
    try {
      const r = await workspaceApi.wsToken(companyId);
      token = r.token;
    } catch {
      // Session likely expired. Hold off and retry; if the user navigates
      // away the `closed` flag will break the loop.
      scheduleReconnect();
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    const sock = new WebSocket(url);
    ws = sock;

    sock.addEventListener("open", () => {
      attempt = 0;
      onStatus?.("open");
    });
    sock.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        dispatch(data as WsInboundEvent);
      } catch {
        // Drop malformed frames rather than throwing — the server shouldn't
        // send them but we don't want one bad frame to kill the channel.
      }
    });
    sock.addEventListener("close", () => {
      ws = null;
      onStatus?.("closed");
      scheduleReconnect();
    });
    sock.addEventListener("error", () => {
      try {
        sock.close();
      } catch {
        // Ignore — close handler already schedules the reconnect.
      }
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    attempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  open();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      handlers.clear();
    },
    sendTyping: (channelId, name) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", channelId, name }));
      }
    },
    subscribe: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

/** @deprecated Prefer `connectCompanySocket(...).subscribe(handler)`. */
export function connectWorkspace(
  companyId: string,
  onEvent: (event: WsInboundEvent) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
): CompanySocket {
  const sock = connectCompanySocket(companyId, onStatus);
  sock.subscribe(onEvent);
  return sock;
}
