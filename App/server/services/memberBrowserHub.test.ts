import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  acquireMemberBrowserLease,
  disconnectMemberBrowser,
  isMemberBrowserOnline,
  memberBrowserPresence,
  openCdpChannel,
  registerBridgeSocket,
  releaseMemberBrowserLease,
  resetMemberBrowserHubForTests,
  type HubDownFrame,
  type HubUpFrame,
} from "./memberBrowserHub.js";

/**
 * The hub multiplexes CDP over one socket a laptop dialled out on, so every
 * test here runs a real `ws` server and a real client socket. A faked socket
 * would let frame ordering, close semantics and backpressure quietly diverge
 * from what the bridge agent actually experiences.
 */

let server: Server;
let sockets: WebSocketServer;
let wsBaseUrl = "";
const clients = new Set<WebSocket>();

before(async () => {
  await initTestDb();
  server = createServer();
  sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws, req) => {
    const browserId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("browser")!;
    registerBridgeSocket({
      browserId,
      companyId: "co_hub",
      ownerUserId: "user_1",
      ws,
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  wsBaseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(resetTestDb);

afterEach(() => {
  for (const client of clients) client.terminate();
  clients.clear();
  resetMemberBrowserHubForTests();
});

after(async () => {
  sockets.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

type Agent = {
  ws: WebSocket;
  send(frame: HubUpFrame): void;
  /** Take the next unread frame of this kind, waiting for it if need be. */
  next(kind: HubDownFrame["t"]): Promise<HubDownFrame>;
  closed: Promise<void>;
};

/** Dial the hub the way the bridge agent does and expose its frame stream. */
async function connectAgent(browserId: string): Promise<Agent> {
  const ws = new WebSocket(`${wsBaseUrl}/?browser=${encodeURIComponent(browserId)}`);
  clients.add(ws);
  const unread: HubDownFrame[] = [];
  const waiters: Array<{ kind: HubDownFrame["t"]; resolve: (frame: HubDownFrame) => void }> = [];
  ws.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as HubDownFrame;
    const index = waiters.findIndex((waiter) => waiter.kind === frame.t);
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
    else unread.push(frame);
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  // The server registers inside its own `connection` handler; wait for the hub
  // to have adopted the socket rather than assuming handler ordering.
  while (!isMemberBrowserOnline(browserId)) await new Promise((resolve) => setTimeout(resolve, 5));

  return {
    ws,
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    next(kind) {
      const index = unread.findIndex((frame) => frame.t === kind);
      if (index >= 0) return Promise.resolve(unread.splice(index, 1)[0]!);
      return new Promise<HubDownFrame>((resolve) => waiters.push({ kind, resolve }));
    },
    closed,
  };
}

/** Open a channel with an agent that answers `cdp.open` the way the real one does. */
async function openChannelWith(
  agent: Agent,
  browserId: string,
  handlers: { onMessage?: (data: string) => void; onClose?: (reason: string) => void } = {},
) {
  const messages: string[] = [];
  const closes: string[] = [];
  const pending = openCdpChannel(browserId, {
    onMessage: (data) => {
      messages.push(data);
      handlers.onMessage?.(data);
    },
    onClose: (reason) => {
      closes.push(reason);
      handlers.onClose?.(reason);
    },
  });
  const open = (await agent.next("cdp.open")) as { t: "cdp.open"; ch: string };
  agent.send({ t: "cdp.opened", ch: open.ch });
  return { channel: await pending, id: open.ch, messages, closes };
}

describe("bridge socket registration", () => {
  test("a second socket for the same browser replaces the first and tears its channels down", async () => {
    const browserId = randomUUID();
    const first = await connectAgent(browserId);
    const opened = await openChannelWith(first, browserId);

    const second = await connectAgent(browserId);
    await first.closed;

    // A laptop that reconnects after a network blip has to win over the
    // half-dead socket the App has not noticed yet — and the channels riding
    // the old socket must not be left believing they are live.
    assert.deepEqual(opened.closes, ["replaced by a newer connection"]);
    assert.equal(isMemberBrowserOnline(browserId), true);
    const reopened = await openChannelWith(second, browserId);
    assert.notEqual(reopened.id, opened.id);
  });

  test("presence reports the browser offline once its socket goes away", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    assert.equal(memberBrowserPresence(browserId).online, true);

    agent.ws.close();
    while (isMemberBrowserOnline(browserId)) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(memberBrowserPresence(browserId), {
      online: false,
      connectedAt: null,
      agentVersion: null,
      busy: false,
    });
  });

  test("a hello frame records the agent version the laptop reported", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    agent.send({ t: "hello", agentVersion: "1.0.0", platform: "darwin 25.5.0" });

    while (memberBrowserPresence(browserId).agentVersion === null) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(memberBrowserPresence(browserId).agentVersion, "1.0.0");
  });
});

describe("the single-driver lease", () => {
  test("is idempotent for its holder and tells a second session the browser is busy", async () => {
    const browserId = randomUUID();
    await connectAgent(browserId);

    assert.deepEqual(acquireMemberBrowserLease(browserId, "session_a"), { ok: true });
    // A session that reconnects mid-chat must keep its browser rather than
    // lock itself out.
    assert.deepEqual(acquireMemberBrowserLease(browserId, "session_a"), { ok: true });
    assert.deepEqual(acquireMemberBrowserLease(browserId, "session_b"), {
      ok: false,
      reason: "busy",
    });
    assert.equal(memberBrowserPresence(browserId).busy, true);

    releaseMemberBrowserLease(browserId, "session_b");
    assert.deepEqual(acquireMemberBrowserLease(browserId, "session_b"), {
      ok: false,
      reason: "busy",
    });

    releaseMemberBrowserLease(browserId, "session_a");
    assert.deepEqual(acquireMemberBrowserLease(browserId, "session_b"), { ok: true });
  });

  test("reports an offline browser rather than handing out a lease on nothing", () => {
    assert.deepEqual(acquireMemberBrowserLease(randomUUID(), "session_a"), {
      ok: false,
      reason: "offline",
    });
  });
});

describe("CDP channels", () => {
  test("a channel resolves only after the agent confirms it attached", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);

    let settled = false;
    const pending = openCdpChannel(browserId, { onMessage: () => {}, onClose: () => {} }).then(
      (channel) => {
        settled = true;
        return channel;
      },
    );
    const open = (await agent.next("cdp.open")) as { t: "cdp.open"; ch: string };
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A caller holding a channel has to be able to assume the far end is real,
    // or Playwright would start talking into a socket Chrome never accepted.
    assert.equal(settled, false);

    agent.send({ t: "cdp.opened", ch: open.ch });
    assert.equal((await pending).id, open.ch);
  });

  test("a channel the agent refuses rejects with the agent's own message", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);

    const pending = openCdpChannel(browserId, { onMessage: () => {}, onClose: () => {} });
    const open = (await agent.next("cdp.open")) as { t: "cdp.open"; ch: string };
    agent.send({ t: "cdp.error", ch: open.ch, message: "Chrome is not installed" });

    await assert.rejects(pending, /Chrome is not installed/);
  });

  test("a channel opened against an offline browser throws instead of waiting", async () => {
    await assert.rejects(
      openCdpChannel(randomUUID(), { onMessage: () => {}, onClose: () => {} }),
      /not connected/i,
    );
  });

  test("cdp.msg frames reach the channel they name and no other", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    const first = await openChannelWith(agent, browserId);
    const second = await openChannelWith(agent, browserId);

    agent.send({ t: "cdp.msg", ch: first.id, data: '{"id":1,"result":{"for":"first"}}' });
    agent.send({ t: "cdp.msg", ch: second.id, data: '{"id":2,"result":{"for":"second"}}' });
    while (first.messages.length === 0 || second.messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Two sessions share one socket, so a mis-routed frame would deliver one
    // browser's page content into the other's transcript.
    assert.deepEqual(first.messages, ['{"id":1,"result":{"for":"first"}}']);
    assert.deepEqual(second.messages, ['{"id":2,"result":{"for":"second"}}']);
  });

  test("sending on a channel puts the payload on the wire verbatim under its channel id", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    const { channel, id } = await openChannelWith(agent, browserId);

    channel.send('{"id":7,"method":"Page.navigate","params":{"url":"https://example.com/"}}');
    const frame = (await agent.next("cdp.msg")) as { t: "cdp.msg"; ch: string; data: string };

    assert.equal(frame.ch, id);
    assert.equal(
      frame.data,
      '{"id":7,"method":"Page.navigate","params":{"url":"https://example.com/"}}',
    );
  });

  test("a channel the agent closes notifies its owner and stops delivering", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    const opened = await openChannelWith(agent, browserId);

    agent.send({ t: "cdp.closed", ch: opened.id, reason: "Chrome was closed" });
    while (opened.closes.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(opened.closes, ["Chrome was closed"]);

    agent.send({ t: "cdp.msg", ch: opened.id, data: "late" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(opened.messages, []);
  });
});

describe("disconnecting a browser", () => {
  test("closes every open channel, notifies their owners, and drops the socket", async () => {
    const browserId = randomUUID();
    const agent = await connectAgent(browserId);
    const first = await openChannelWith(agent, browserId);
    const second = await openChannelWith(agent, browserId);
    acquireMemberBrowserLease(browserId, "session_a");

    disconnectMemberBrowser(browserId, "revoked");
    await agent.closed;

    // Revocation that only stopped the next session would leave an already
    // connected employee driving the browser until an idle timer fired.
    assert.deepEqual(first.closes, ["revoked"]);
    assert.deepEqual(second.closes, ["revoked"]);
    assert.equal(isMemberBrowserOnline(browserId), false);
    assert.equal(memberBrowserPresence(browserId).busy, false);
  });

  test("disconnecting a browser that was never connected is a no-op", () => {
    disconnectMemberBrowser(randomUUID(), "revoked");
  });
});
