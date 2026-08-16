import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  isMemberBrowserOnline,
  registerBridgeSocket,
  resetMemberBrowserHubForTests,
  type HubDownFrame,
  type HubUpFrame,
} from "./memberBrowserHub.js";
import {
  mintCdpEndpoint,
  outstandingCdpTicketsForTests,
  shutdownMemberBrowserRelayForTests,
} from "./memberBrowserRelay.js";

/**
 * The relay is the only place Playwright touches: it hands out a URL that has
 * to behave like a Chrome DevTools endpoint. Everything here therefore dials it
 * with a real socket, the way `chromium.connectOverCDP()` would.
 */

let bridgeServer: Server;
let bridgeSockets: WebSocketServer;
let bridgeUrl = "";
const clients = new Set<WebSocket>();

before(async () => {
  await initTestDb();
  bridgeServer = createServer();
  bridgeSockets = new WebSocketServer({ server: bridgeServer });
  bridgeSockets.on("connection", (ws, req) => {
    const browserId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("browser")!;
    registerBridgeSocket({ browserId, companyId: "co_relay", ownerUserId: "user_1", ws });
  });
  await new Promise<void>((resolve) => {
    bridgeServer.listen(0, "127.0.0.1", resolve);
  });
  bridgeUrl = `ws://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
});

beforeEach(resetTestDb);

afterEach(() => {
  for (const client of clients) client.terminate();
  clients.clear();
  resetMemberBrowserHubForTests();
});

after(async () => {
  await shutdownMemberBrowserRelayForTests();
  bridgeSockets.close();
  await new Promise<void>((resolve, reject) => {
    bridgeServer.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

/**
 * A stand-in for the bridge agent on a Member's laptop: it answers `cdp.open`
 * and echoes whatever the App sends, tagged so the test can prove the payload
 * crossed both hops unaltered.
 */
async function connectFakeAgent(browserId: string) {
  const ws = new WebSocket(`${bridgeUrl}/?browser=${encodeURIComponent(browserId)}`);
  clients.add(ws);
  const toChrome: string[] = [];
  let openedChannel: string | null = null;
  ws.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as HubDownFrame;
    const reply = (up: HubUpFrame) => ws.send(JSON.stringify(up));
    if (frame.t === "cdp.open") {
      openedChannel = frame.ch;
      reply({ t: "cdp.opened", ch: frame.ch });
      return;
    }
    if (frame.t === "cdp.msg") {
      toChrome.push(frame.data);
      reply({ t: "cdp.msg", ch: frame.ch, data: `echo:${frame.data}` });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  while (!isMemberBrowserOnline(browserId)) await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    ws,
    toChrome,
    channelId: () => openedChannel,
    send(frame: HubUpFrame) {
      ws.send(JSON.stringify(frame));
    },
  };
}

/** Dial a minted endpoint the way Playwright would, resolving on the handshake. */
async function dial(endpoint: string): Promise<WebSocket> {
  const ws = new WebSocket(endpoint);
  clients.add(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/**
 * The relay opens the bridge channel after the handshake, so a test that ends
 * on the handshake alone strands an unanswered `cdp.open` for its full timeout.
 */
async function awaitChannel(agent: { channelId: () => string | null }): Promise<string> {
  while (!agent.channelId()) await new Promise((resolve) => setTimeout(resolve, 5));
  return agent.channelId()!;
}

async function dialRefusal(endpoint: string): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    clients.add(ws);
    ws.once("open", () => reject(new Error("the relay accepted a socket it should have refused")));
    ws.once("error", (error) => resolve(error));
  });
}

describe("minted CDP endpoints", () => {
  test("names the loopback address as an IP literal rather than a hostname", async () => {
    const endpoint = await mintCdpEndpoint({ browserId: randomUUID(), sessionId: randomUUID() });
    const url = new URL(endpoint);

    // Playwright dials through its own agent, and a hostname would take a DNS
    // path the outbound network policy treats as a non-public address.
    assert.equal(url.protocol, "ws:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.notEqual(url.hostname, "localhost");
    assert.ok(Number(url.port) > 0);
    assert.match(url.pathname, /^\/cdp\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,128}$/);
  });

  test("mints a distinct ticket per session", async () => {
    const first = await mintCdpEndpoint({ browserId: randomUUID(), sessionId: randomUUID() });
    const second = await mintCdpEndpoint({ browserId: randomUUID(), sessionId: randomUUID() });
    assert.notEqual(first, second);
    assert.equal(new URL(first).port, new URL(second).port);
  });
});

describe("ticket authorization", () => {
  test("refuses a second dial that replays a spent ticket", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const unspent = outstandingCdpTicketsForTests();
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    assert.equal(outstandingCdpTicketsForTests(), unspent + 1);

    await dial(endpoint);
    await awaitChannel(agent);
    // The ticket is spent at the upgrade, so a captured URL is worthless even
    // inside its TTL — it is one connection into one browser, not a password.
    assert.equal(outstandingCdpTicketsForTests(), unspent);
    await dialRefusal(endpoint);
  });

  test("refuses a forged ticket, an unknown ticket, and a malformed path", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const unspent = outstandingCdpTicketsForTests();
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    const url = new URL(endpoint);
    const [, , ticketId] = url.pathname.split("/");

    await dialRefusal(`ws://127.0.0.1:${url.port}/cdp/${ticketId}/${"A".repeat(32)}`);
    await dialRefusal(`ws://127.0.0.1:${url.port}/cdp/${randomUUID()}/${"A".repeat(32)}`);
    await dialRefusal(`ws://127.0.0.1:${url.port}/`);
    await dialRefusal(`ws://127.0.0.1:${url.port}/cdp/${ticketId}`);

    // None of that may have burned the real ticket.
    assert.equal(outstandingCdpTicketsForTests(), unspent + 1);
    await dial(endpoint);
    await awaitChannel(agent);
  });
});

describe("piping CDP", () => {
  test("carries frames verbatim in both directions", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    const app = await dial(endpoint);

    const fromRelay: string[] = [];
    app.on("message", (raw: Buffer) => fromRelay.push(raw.toString("utf8")));
    const request = '{"id":1,"method":"Target.getTargets","params":{"filter":[{"type":"page"}]}}';
    app.send(request);

    while (fromRelay.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(agent.toChrome, [request]);
    assert.deepEqual(fromRelay, [`echo:${request}`]);
  });

  test("delivers frames the App sent before the agent had opened the channel", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });

    // Playwright starts talking the instant the handshake completes, so a frame
    // that arrives before the far end is up must be queued, not dropped.
    const app = new WebSocket(endpoint);
    clients.add(app);
    await new Promise<void>((resolve, reject) => {
      app.once("open", () => resolve());
      app.once("error", reject);
    });
    app.send('{"id":1,"method":"Browser.getVersion"}');

    while (agent.toChrome.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(agent.toChrome, ['{"id":1,"method":"Browser.getVersion"}']);
  });
});

describe("closing a relayed connection", () => {
  test("closing the App end closes the channel on the agent", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    const app = await dial(endpoint);
    await awaitChannel(agent);

    const closedDown = new Promise<HubDownFrame>((resolve) => {
      agent.ws.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString("utf8")) as HubDownFrame;
        if (frame.t === "cdp.close") resolve(frame);
      });
    });
    app.close();

    // Otherwise the laptop would keep a CDP socket into its own Chrome open
    // for a session the App has already finished with.
    assert.deepEqual(await closedDown, { t: "cdp.close", ch: agent.channelId() });
  });

  test("the agent closing its channel closes the App's socket", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    const app = await dial(endpoint);
    await awaitChannel(agent);

    const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
    agent.send({ t: "cdp.closed", ch: agent.channelId()!, reason: "Chrome was closed" });

    // Playwright has to learn the browser is gone; a socket left open would
    // hang the tool call until its own timeout instead of erroring.
    await closed;
  });

  test("losing the bridge socket closes the App's socket", async () => {
    const browserId = randomUUID();
    const agent = await connectFakeAgent(browserId);
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });
    const app = await dial(endpoint);
    await awaitChannel(agent);

    const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
    agent.ws.close();
    await closed;
  });

  test("a ticket for a browser that went offline is accepted and then immediately closed", async () => {
    const browserId = randomUUID();
    const endpoint = await mintCdpEndpoint({ browserId, sessionId: randomUUID() });

    const app = await dial(endpoint);
    // The upgrade only proves the ticket; whether a laptop is reachable is
    // decided one hop later, and Playwright learns it as a closed socket.
    await new Promise<void>((resolve) => app.once("close", () => resolve()));
  });
});
