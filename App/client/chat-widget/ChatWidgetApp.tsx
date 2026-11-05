import React from "react";
import { Bot, Loader2, RotateCw, Send, X } from "lucide-react";

import {
  SUPPORT_CHAT_LIMITS,
  SUPPORT_CHAT_POST_SOURCE,
  chatUnreadCount,
  type ChatEmailStatus,
  type ChatFrameMessage,
  type ChatHostMessage,
  type ChatWidgetConfig,
  type ChatWidgetMessage,
} from "../../shared/supportChat";
import { ChatApiError, chatApi, chatTokenStore, newClientId, type ChatApi } from "./api";
import { pollDelayMs, textParts } from "./lib";

/**
 * The Chat widget, inside its frame on a company's site. A visitor's token stays in
 * this frame's own storage and goes only to this install's API, so the page around it
 * never holds anything that opens the conversation. What it hears from that page is
 * whether the panel is showing, and what it tells that page is how many replies wait.
 */

type Outgoing = { clientId: string; text: string; failed: string | null };

/** The widget's bundle leaves the App's guard behind, so its few fields carry the marks. */
const PASSWORD_MANAGERS_LEAVE_THIS_ALONE = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

function tellHost(message: Omit<ChatFrameMessage, "source"> & { count?: number }): void {
  if (window.parent === window) return;
  // Only a site on the owners' list can have framed this, and none of it is secret.
  window.parent.postMessage({ source: SUPPORT_CHAT_POST_SOURCE, ...message }, "*");
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function MessageText({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-5">
      {textParts(text).map((part, index) =>
        part.kind === "link" ? (
          <a
            key={index}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline"
          >
            {part.value}
          </a>
        ) : (
          <React.Fragment key={index}>{part.value}</React.Fragment>
        ),
      )}
    </p>
  );
}

function ChatLine({ message }: { message: ChatWidgetMessage }) {
  if (message.from === "system") {
    return <p className="px-6 text-center text-xs leading-5 text-slate-500">{message.text}</p>;
  }
  if (message.from === "visitor") {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3 py-2 text-white">
          <MessageText text={message.text} />
        </div>
        <time className="text-xs text-slate-500" dateTime={message.at}>
          {timeOf(message.at)}
        </time>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="flex items-center gap-1 text-xs text-slate-500">
        {message.from === "ai" && <Bot size={12} aria-hidden="true" />}
        {message.from === "ai" ? "AI Employee" : message.name}
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-slate-900">
        <MessageText text={message.text} />
      </div>
      <time className="text-xs text-slate-500" dateTime={message.at}>
        {timeOf(message.at)}
      </time>
    </div>
  );
}

function EmailPrompt({
  status,
  storageBlocked,
  onSubmit,
}: {
  status: ChatEmailStatus;
  storageBlocked: boolean;
  onSubmit: (email: string, name: string) => Promise<void>;
}) {
  const [asking, setAsking] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  if (status.state === "pending") {
    return (
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
        Check your inbox. If {status.address} can take email from us, a link is on its way. Replies
        go there once you press Confirm.
      </p>
    );
  }
  if (status.state === "confirmed") {
    return (
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
        Replies you miss here go to {status.address}.
      </p>
    );
  }
  if (!asking) {
    return (
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
        {storageBlocked
          ? "This browser will not keep this chat if you leave the page. "
          : "You can leave this page and come back. "}
        <button
          type="button"
          className="inline-flex min-h-8 items-center font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900"
          onClick={() => setAsking(true)}
        >
          Get replies by email
        </button>
      </div>
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(email.trim(), name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-2 rounded-lg bg-slate-50 p-3"
      noValidate
    >
      <p className="text-xs leading-5 text-slate-600">
        We will email a link to confirm the address is yours. Nothing else is sent until you press
        it.
      </p>
      <input
        type="email"
        aria-label="Your email address"
        placeholder="you@example.com"
        autoComplete="email"
        required
        value={email}
        maxLength={320}
        onChange={(event) => setEmail(event.target.value)}
        className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus:border-indigo-500 sm:text-sm focus:outline-none"
        {...PASSWORD_MANAGERS_LEAVE_THIS_ALONE}
      />
      <input
        type="text"
        aria-label="Your name (optional)"
        placeholder="Your name (optional)"
        autoComplete="name"
        value={name}
        maxLength={SUPPORT_CHAT_LIMITS.nameChars}
        onChange={(event) => setName(event.target.value)}
        className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus:border-indigo-500 sm:text-sm focus:outline-none"
        {...PASSWORD_MANAGERS_LEAVE_THIS_ALONE}
      />
      {error && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="h-8 rounded-lg px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          onClick={() => setAsking(false)}
        >
          Not now
        </button>
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          Send link
        </button>
      </div>
    </form>
  );
}

export function ChatWidgetApp({ widgetKey }: { widgetKey: string }) {
  const api: ChatApi = React.useMemo(() => chatApi(widgetKey), [widgetKey]);
  const store = React.useMemo(() => chatTokenStore(widgetKey), [widgetKey]);
  const tokenRef = React.useRef<string | null>(store.read());
  const [started, setStarted] = React.useState(Boolean(tokenRef.current));
  const [storageBlocked, setStorageBlocked] = React.useState(false);

  const [config, setConfig] = React.useState<ChatWidgetConfig | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [messages, setMessages] = React.useState<ChatWidgetMessage[]>([]);
  const [outgoing, setOutgoing] = React.useState<Outgoing[]>([]);
  const [email, setEmail] = React.useState<ChatEmailStatus>({ state: "none", address: "" });
  const [readSeq, setReadSeq] = React.useState(0);
  const [panelOpen, setPanelOpen] = React.useState(window.parent === window);
  const [pageVisible, setPageVisible] = React.useState(document.visibilityState === "visible");
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const [ending, setEnding] = React.useState(false);
  const [endingBusy, setEndingBusy] = React.useState(false);
  const afterRef = React.useRef(0);
  const logRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const showing = panelOpen && pageVisible;

  const forget = React.useCallback(() => {
    tokenRef.current = null;
    store.clear();
    afterRef.current = 0;
    setStarted(false);
    setMessages([]);
    setOutgoing([]);
    setReadSeq(0);
    setEmail({ state: "none", address: "" });
    tellHost({ type: "ended" });
    tellHost({ type: "unread", count: 0 });
  }, [store]);

  // Read on until the conversation is caught up. Rows carry their place in it, so
  // nothing here can skip one or show one twice, whatever order answers come in.
  const catchUp = React.useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    for (let page = 0; page < 20; page++) {
      const result = await api.conversation(token, afterRef.current);
      if (tokenRef.current !== token) return;
      afterRef.current = result.nextAfter;
      setEmail(result.email);
      setReadSeq((current) => Math.max(current, result.readSeq));
      if (result.messages.length > 0) {
        setMessages((current) => {
          const bySeq = new Map(current.map((message) => [message.seq, message]));
          for (const message of result.messages) bySeq.set(message.seq, message);
          return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        });
        const landed = new Set(result.messages.map((message) => message.clientId));
        setOutgoing((current) => current.filter((item) => !landed.has(item.clientId)));
      }
      if (!result.hasMore) return;
    }
  }, [api]);

  // Whether the panel is showing is the page's to say. Only the page that framed this
  // gets a hearing, and all it can do is move this switch.
  React.useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data as Partial<ChatHostMessage> | null;
      if (!data || data.source !== SUPPORT_CHAT_POST_SOURCE) return;
      if (data.type === "opened") setPanelOpen(true);
      if (data.type === "closed") setPanelOpen(false);
    }
    function onVisibility() {
      setPageVisible(document.visibilityState === "visible");
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") tellHost({ type: "close" });
    }
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    tellHost({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  React.useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setUnavailable(true));
  }, [api]);

  // Look for replies: often while someone is looking, seldom while nobody is, and not
  // at all until they have written something, so a visitor who never does costs nothing.
  React.useEffect(() => {
    if (!started) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await catchUp();
        failures = 0;
        setError((current) => (current === OFFLINE ? "" : current));
      } catch (err) {
        if (err instanceof ChatApiError && err.status === 401) {
          forget();
          return;
        }
        failures += 1;
        if (failures >= 3) setError(OFFLINE);
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollDelayMs({ open: showing, failures }));
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [started, showing, catchUp, forget]);

  const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;
  const unread = chatUnreadCount(messages, readSeq);

  React.useEffect(() => {
    tellHost({ type: "unread", count: showing ? 0 : unread });
  }, [showing, unread]);

  // Only someone actually looking counts as having read it: this is what decides
  // whether a reply also goes by email.
  React.useEffect(() => {
    const token = tokenRef.current;
    if (!showing || !token || lastSeq <= readSeq) return;
    setReadSeq(lastSeq);
    void api.markRead(token, lastSeq).catch(() => {
      // Worst case they are emailed something they already saw.
    });
  }, [api, showing, lastSeq, readSeq]);

  React.useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length, outgoing.length, email.state]);

  React.useEffect(() => {
    if (showing) composerRef.current?.focus({ preventScroll: true });
  }, [showing]);

  /** Mint a token first, on its own: losing the answer to a message must not lose it. */
  async function ensureToken(): Promise<string> {
    if (tokenRef.current) return tokenRef.current;
    const { token } = await api.startVisitor();
    tokenRef.current = token;
    if (!store.write(token)) setStorageBlocked(true);
    setStarted(true);
    tellHost({ type: "started" });
    return token;
  }

  async function deliver(item: Outgoing) {
    setError("");
    try {
      const token = await ensureToken();
      await api.send(token, item.clientId, item.text);
      await catchUp();
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 401) {
        forget();
        setDraft(item.text);
        setError(err.message);
        return;
      }
      const reason = err instanceof Error ? err.message : "That did not send.";
      setOutgoing((current) =>
        current.map((entry) =>
          entry.clientId === item.clientId ? { ...entry, failed: reason } : entry,
        ),
      );
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text) return;
    if (text.length > SUPPORT_CHAT_LIMITS.messageChars) {
      setError("That message is too long. Try splitting it up.");
      return;
    }
    const item: Outgoing = { clientId: newClientId(), text, failed: null };
    setOutgoing((current) => [...current, item]);
    setDraft("");
    void deliver(item);
  }

  function retry(item: Outgoing) {
    setOutgoing((current) =>
      current.map((entry) =>
        entry.clientId === item.clientId ? { ...entry, failed: null } : entry,
      ),
    );
    void deliver(item);
  }

  async function requestEmail(address: string, name: string) {
    const token = await ensureToken();
    const result = await api.requestEmail(token, address, name);
    setEmail(result.email);
  }

  async function endChat() {
    const token = tokenRef.current;
    setEndingBusy(true);
    try {
      if (token) await api.end(token);
      forget();
      setEnding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setEndingBusy(false);
    }
  }

  if (unavailable) {
    return (
      <main className="flex h-full items-center justify-center p-6">
        <p className="text-center text-sm text-slate-500">This chat is not available.</p>
      </main>
    );
  }
  if (!config) {
    return (
      <main className="flex h-full items-center justify-center" aria-busy="true">
        <Loader2 size={20} className="animate-spin text-slate-400" aria-label="Loading" />
      </main>
    );
  }

  const hasWritten = messages.some((message) => message.from === "visitor");
  return (
    <main className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{config.title}</h1>
        {started && (
          <button
            type="button"
            onClick={() => setEnding((current) => !current)}
            className="h-8 shrink-0 rounded-lg px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            End chat
          </button>
        )}
        {window.parent !== window && (
          <button
            type="button"
            aria-label="Close chat"
            onClick={() => tellHost({ type: "close" })}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </header>

      {ending && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs leading-5 text-slate-600">
            End this chat? It will not open here again, on this computer or any other.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEnding(false)}
              className="h-8 rounded-lg px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Keep chatting
            </button>
            <button
              type="button"
              disabled={endingBusy}
              onClick={() => void endChat()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-800 px-3 text-xs font-medium text-white hover:bg-slate-900 disabled:opacity-50"
            >
              {endingBusy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              End chat
            </button>
          </div>
        </div>
      )}

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
      >
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-xs text-slate-500">{config.title}</span>
          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-slate-900">
            <MessageText text={config.greeting} />
          </div>
        </div>
        {messages.map((message) => (
          <ChatLine key={message.seq} message={message} />
        ))}
        {outgoing.map((item) => (
          <div key={item.clientId} className="flex flex-col items-end gap-0.5">
            <div
              className={
                item.failed
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-rose-50 px-3 py-2 text-rose-900 ring-1 ring-inset ring-rose-200"
                  : "max-w-[85%] rounded-2xl rounded-br-md bg-indigo-500 px-3 py-2 text-white"
              }
            >
              <MessageText text={item.text} />
            </div>
            {item.failed ? (
              <div className="flex items-center gap-2 text-xs text-rose-700">
                <span role="alert">{item.failed}</span>
                <button
                  type="button"
                  onClick={() => retry(item)}
                  className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-2"
                >
                  <RotateCw size={11} aria-hidden="true" /> Try again
                </button>
              </div>
            ) : (
              <span className="text-xs text-slate-500">Sending…</span>
            )}
          </div>
        ))}
        {hasWritten && (
          <EmailPrompt
            status={email}
            storageBlocked={storageBlocked}
            onSubmit={requestEmail}
          />
        )}
      </div>

      {error && (
        <p role="alert" className="border-t border-slate-200 px-4 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}

      {config.open ? (
        <form
          className="flex items-end gap-2 border-t border-slate-200 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={composerRef}
            aria-label="Your message"
            placeholder="Write a message"
            rows={1}
            value={draft}
            maxLength={SUPPORT_CHAT_LIMITS.messageChars}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-slate-300 px-2.5 py-1.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none sm:text-sm"
            {...PASSWORD_MANAGERS_LEAVE_THIS_ALONE}
          />
          <button
            type="submit"
            aria-label="Send message"
            disabled={!draft.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            <Send size={15} aria-hidden="true" />
          </button>
        </form>
      ) : (
        <p className="border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-500">
          This chat is closed just now.
        </p>
      )}
    </main>
  );
}

const OFFLINE = "Having trouble reaching the chat. We will keep trying.";
