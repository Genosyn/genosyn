import crypto from "node:crypto";
import type { WebSocket } from "ws";

import { markMemberBrowserOffline, markMemberBrowserOnline } from "./memberBrowsers.js";

/**
 * In-memory registry of connected bridge agents, and the CDP channels the App
 * multiplexes over each one.
 *
 * The App can never dial a laptop, so the laptop dials out: the bridge agent
 * opens one WebSocket to `/api/internal/member-browsers/socket` and keeps it
 * there. Everything else rides that single socket as small JSON frames, with a
 * channel id so several logical CDP connections can share it.
 *
 * Nothing here is persisted. A restart drops every socket; agents reconnect
 * with backoff and the browser rows flip back to `online` on their own.
 */

/** How long a bridge may go silent before we treat the laptop as gone. */
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 70_000;

/** Frames the App sends down to an agent. */
export type HubDownFrame =
  | { t: "policy"; allowedHosts: string[]; appOrigin: string }
  | { t: "cdp.open"; ch: string }
  | { t: "cdp.msg"; ch: string; data: string }
  | { t: "cdp.close"; ch: string }
  | { t: "ping" };

/** Frames an agent sends up to the App. */
export type HubUpFrame =
  | { t: "hello"; agentVersion?: string; browserVersion?: string; platform?: string }
  | { t: "cdp.opened"; ch: string }
  | { t: "cdp.error"; ch: string; message: string }
  | { t: "cdp.msg"; ch: string; data: string }
  | { t: "cdp.closed"; ch: string; reason?: string }
  | { t: "pong" };

export type CdpChannel = {
  id: string;
  /** Push one raw CDP JSON message down to the agent. */
  send(data: string): void;
  close(reason: string): void;
};

type ChannelState = {
  id: string;
  browserId: string;
  onMessage: (data: string) => void;
  onClose: (reason: string) => void;
  opened: boolean;
  settle: ((result: { ok: true } | { ok: false; message: string }) => void) | null;
};

type BridgeState = {
  browserId: string;
  companyId: string;
  ownerUserId: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  agentVersion: string | null;
  channels: Map<string, ChannelState>;
  heartbeat: NodeJS.Timeout | null;
  /**
   * The single session allowed to drive this browser. Two employees sharing
   * one Chrome would each auto-attach to the other's tabs, so the second
   * caller is told the browser is busy instead.
   */
  lease: { sessionId: string; takenAt: number } | null;
};

const bridges = new Map<string, BridgeState>();

function send(state: BridgeState, frame: HubDownFrame): void {
  try {
    state.ws.send(JSON.stringify(frame));
  } catch {
    // A dead socket surfaces through the close handler; dropping the frame
    // here keeps callers from having to care.
  }
}

export function isMemberBrowserOnline(browserId: string): boolean {
  return bridges.has(browserId);
}

export function memberBrowserPresence(browserId: string): {
  online: boolean;
  connectedAt: number | null;
  agentVersion: string | null;
  busy: boolean;
} {
  const state = bridges.get(browserId);
  return {
    online: Boolean(state),
    connectedAt: state?.connectedAt ?? null,
    agentVersion: state?.agentVersion ?? null,
    busy: Boolean(state?.lease),
  };
}

/**
 * Take the single-driver lease. Idempotent for the holder, so a session that
 * reconnects mid-chat keeps its browser instead of locking itself out.
 */
export function acquireMemberBrowserLease(
  browserId: string,
  sessionId: string,
): { ok: true } | { ok: false; reason: string } {
  const state = bridges.get(browserId);
  if (!state) return { ok: false, reason: "offline" };
  if (state.lease && state.lease.sessionId !== sessionId) {
    return { ok: false, reason: "busy" };
  }
  state.lease = { sessionId, takenAt: Date.now() };
  return { ok: true };
}

export function releaseMemberBrowserLease(browserId: string, sessionId: string): void {
  const state = bridges.get(browserId);
  if (!state || !state.lease) return;
  if (state.lease.sessionId !== sessionId) return;
  state.lease = null;
}

/**
 * Open a CDP channel to the agent's Chrome. Resolves once the agent confirms
 * it attached, so a caller that gets a channel back knows the far end is real.
 */
export async function openCdpChannel(
  browserId: string,
  handlers: { onMessage: (data: string) => void; onClose: (reason: string) => void },
  timeoutMs = 15_000,
): Promise<CdpChannel> {
  const state = bridges.get(browserId);
  if (!state) throw new Error("The paired browser is not connected");

  const id = crypto.randomUUID();
  const channel: ChannelState = {
    id,
    browserId,
    onMessage: handlers.onMessage,
    onClose: handlers.onClose,
    opened: false,
    settle: null,
  };
  state.channels.set(id, channel);

  const opened = new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    channel.settle = resolve;
  });
  send(state, { t: "cdp.open", ch: id });

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<{ ok: false; message: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, message: "The paired browser did not answer in time" }),
      timeoutMs,
    );
  });
  const result = await Promise.race([opened, timeout]);
  if (timer) clearTimeout(timer);
  if (!result.ok) {
    state.channels.delete(id);
    send(state, { t: "cdp.close", ch: id });
    throw new Error(result.message);
  }

  return {
    id,
    send(data: string) {
      const live = bridges.get(browserId);
      if (!live || !live.channels.has(id)) return;
      send(live, { t: "cdp.msg", ch: id, data });
    },
    close(reason: string) {
      const live = bridges.get(browserId);
      if (!live) return;
      const ch = live.channels.get(id);
      if (!ch) return;
      live.channels.delete(id);
      send(live, { t: "cdp.close", ch: id });
      ch.onClose(reason);
    },
  };
}

/** Push the current host policy to a connected agent. */
export function pushMemberBrowserPolicy(
  browserId: string,
  policy: { allowedHosts: string[]; appOrigin: string },
): void {
  const state = bridges.get(browserId);
  if (!state) return;
  send(state, { t: "policy", ...policy });
}

/** Drop an agent's socket — used by revocation and by the owner's kill switch. */
export function disconnectMemberBrowser(browserId: string, reason: string): void {
  const state = bridges.get(browserId);
  if (!state) return;
  teardown(state, reason);
  try {
    state.ws.close(1000, reason.slice(0, 120));
  } catch {
    // already gone
  }
}

function teardown(state: BridgeState, reason: string): void {
  // A socket that was already replaced still fires `close` a moment later.
  // Only the socket that is *currently* registered may mark the browser
  // offline, or a reconnect gets flagged as down by the connection it replaced.
  const isCurrent = bridges.get(state.browserId) === state;
  if (isCurrent) bridges.delete(state.browserId);
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = null;
  for (const channel of state.channels.values()) {
    channel.settle?.({ ok: false, message: reason });
    try {
      channel.onClose(reason);
    } catch {
      // a listener throwing must not strand the rest
    }
  }
  state.channels.clear();
  state.lease = null;
  if (isCurrent) {
    void markMemberBrowserOffline(state.browserId).catch(() => {
      // best-effort: the row is display state, the socket is the truth
    });
  }
}

/**
 * Adopt an authenticated bridge socket. Replaces any previous socket for the
 * same browser — a laptop that reconnects after a network blip should win over
 * the half-dead socket the App has not noticed yet.
 */
export function registerBridgeSocket(params: {
  browserId: string;
  companyId: string;
  ownerUserId: string;
  ws: WebSocket;
  onHello?: (info: { browserVersion?: string; platform?: string }) => void;
}): void {
  const previous = bridges.get(params.browserId);
  if (previous) {
    teardown(previous, "replaced by a newer connection");
    try {
      previous.ws.close(1000, "replaced");
    } catch {
      // ignore
    }
  }

  const state: BridgeState = {
    browserId: params.browserId,
    companyId: params.companyId,
    ownerUserId: params.ownerUserId,
    ws: params.ws,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    agentVersion: null,
    channels: new Map(),
    heartbeat: null,
    lease: null,
  };
  bridges.set(params.browserId, state);

  state.heartbeat = setInterval(() => {
    if (Date.now() - state.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
      // A closed lid leaves a TCP socket that looks alive for minutes. Without
      // this the model would keep issuing actions into a void.
      disconnectMemberBrowser(state.browserId, "the paired computer stopped responding");
      return;
    }
    send(state, { t: "ping" });
  }, HEARTBEAT_INTERVAL_MS);
  state.heartbeat.unref?.();

  params.ws.on("message", (raw: Buffer | string) => {
    state.lastSeenAt = Date.now();
    let frame: HubUpFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as HubUpFrame;
    } catch {
      return;
    }
    handleUpFrame(state, frame, params.onHello);
  });

  params.ws.on("close", () => teardown(state, "the paired browser disconnected"));
  params.ws.on("error", () => teardown(state, "the paired browser connection failed"));
}

function handleUpFrame(
  state: BridgeState,
  frame: HubUpFrame,
  onHello?: (info: { browserVersion?: string; platform?: string }) => void,
): void {
  switch (frame.t) {
    case "hello": {
      state.agentVersion = frame.agentVersion ?? null;
      onHello?.({ browserVersion: frame.browserVersion, platform: frame.platform });
      void markMemberBrowserOnline(state.browserId, {
        browserVersion: frame.browserVersion ?? null,
        platform: frame.platform ?? null,
      }).catch(() => {
        // display state only
      });
      return;
    }
    case "pong":
      return;
    case "cdp.opened": {
      const channel = state.channels.get(frame.ch);
      if (!channel) return;
      channel.opened = true;
      channel.settle?.({ ok: true });
      channel.settle = null;
      return;
    }
    case "cdp.error": {
      const channel = state.channels.get(frame.ch);
      if (!channel) return;
      state.channels.delete(frame.ch);
      if (channel.settle) {
        channel.settle({ ok: false, message: frame.message || "the paired browser refused" });
        channel.settle = null;
        return;
      }
      channel.onClose(frame.message || "the paired browser refused");
      return;
    }
    case "cdp.msg": {
      const channel = state.channels.get(frame.ch);
      if (!channel || typeof frame.data !== "string") return;
      channel.onMessage(frame.data);
      return;
    }
    case "cdp.closed": {
      const channel = state.channels.get(frame.ch);
      if (!channel) return;
      state.channels.delete(frame.ch);
      channel.settle?.({ ok: false, message: frame.reason || "closed" });
      channel.settle = null;
      channel.onClose(frame.reason || "the paired browser closed the connection");
      return;
    }
    default:
      return;
  }
}

/** Test seam: drop every socket without touching the database. */
export function resetMemberBrowserHubForTests(): void {
  for (const state of [...bridges.values()]) {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.channels.clear();
  }
  bridges.clear();
}
