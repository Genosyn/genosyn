import type {
  ChatConversationPage,
  ChatEmailStatus,
  ChatWidgetConfig,
  ChatWidgetMessage,
} from "../../shared/supportChat";

/**
 * The widget's calls. Same origin as the frame, so there is nothing to allow across
 * sites and no cookie to send. The visitor's token goes in a header, never in a URL,
 * where it would end up in logs and history.
 */

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

async function call<T>(
  path: string,
  options: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/support-chat/${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ChatApiError("You seem to be offline. We will keep trying.", 0, "offline");
  }
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    throw new ChatApiError(
      data?.error ?? "Something went wrong. Please try again.",
      response.status,
      data?.code ?? "",
    );
  }
  return data as T;
}

export function chatApi(widgetKey: string) {
  const base = encodeURIComponent(widgetKey);
  return {
    config: () => call<ChatWidgetConfig>(base),
    startVisitor: () => call<{ token: string }>(`${base}/visitors`, { method: "POST", body: {} }),
    conversation: (token: string, after: number) =>
      call<ChatConversationPage>(`${base}/conversation?after=${after}`, { token }),
    send: (token: string, clientId: string, text: string) =>
      call<{ message: ChatWidgetMessage }>(`${base}/messages`, {
        method: "POST",
        token,
        body: { clientId, text },
      }),
    markRead: (token: string, seq: number) =>
      call<{ readSeq: number }>(`${base}/read`, { method: "POST", token, body: { seq } }),
    requestEmail: (token: string, email: string, name: string) =>
      call<{ email: ChatEmailStatus }>(`${base}/email`, {
        method: "POST",
        token,
        body: { email, ...(name.trim() ? { name } : {}) },
      }),
    end: (token: string) => call<{ ok: boolean }>(`${base}/visitor`, { method: "DELETE", token }),
  };
}

export type ChatApi = ReturnType<typeof chatApi>;

/** A retry must carry the same id. `randomUUID` exists only on secure pages. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The token lives in this frame's own storage, out of reach of the page around it. */
export function chatTokenStore(widgetKey: string) {
  const key = `genosyn-support-chat:${widgetKey}`;
  return {
    read(): string | null {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    /** False where the browser keeps nothing for a frame like this one. */
    write(token: string): boolean {
      try {
        window.localStorage.setItem(key, token);
        return true;
      } catch {
        return false;
      }
    },
    clear(): void {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Nothing was kept, so there is nothing to forget.
      }
    },
  };
}
