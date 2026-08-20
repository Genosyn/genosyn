import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import type { WebSocket } from "ws";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { attachViewerSocket, resetBrowserRpcActivityForTests } from "./browserSessions.js";
import {
  markBrowserRecordingRunFinalizing,
  releaseBrowserRecordingRunFinalizing,
} from "./browserRecordings.js";

/**
 * The live viewer's address bar is a second way to drive the employee's
 * browser, so it needs the same boundary the model's `browser_open` has.
 *
 * Two things are being pinned here. First, that navigation requires control:
 * a viewer who is merely *watching* must not be able to move the page under
 * someone else. Second, that holding control does not lift the company's host
 * policy — take-over exists to finish a captcha, not to walk a signed-in
 * browser somewhere the company excluded.
 *
 * No Chromium runs in these tests. That is deliberate and it is what makes the
 * assertions sharp: a URL that clears policy gets as far as "the browser is no
 * longer running", which no refused URL ever reaches.
 */

type Sent = { type: string; [key: string]: unknown };

/** Minimal stand-in for the viewer's socket — enough for the hub to talk to. */
function fakeSocket() {
  const sent: Sent[] = [];
  const handlers = new Map<string, (arg: unknown) => void>();
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send(payload: string) {
      sent.push(JSON.parse(payload) as Sent);
    },
    on(event: string, cb: (arg: unknown) => void) {
      handlers.set(event, cb);
    },
    close() {
      /* no-op */
    },
  };
  return {
    ws: ws as unknown as WebSocket,
    sent,
    /** Deliver a viewer→server message and let the async handler settle. */
    async deliver(msg: unknown) {
      handlers.get("message")?.(JSON.stringify(msg));
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Everything the server pushed since the last drain. */
    drain() {
      return sent.splice(0, sent.length);
    },
  };
}

const companyId = testCompanyId();
let employee: AIEmployee;
let session: BrowserSession;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  resetBrowserRpcActivityForTests();
  await resetTestDb();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Support",
    browserEnabled: true,
    browserAllowedHosts: "*.example.com",
  });
  session = await insert(BrowserSession, {
    companyId,
    employeeId: employee.id,
    conversationId: null,
    runId: null,
    memberBrowserId: null,
    mcpToken: `tok_${Math.random().toString(16).slice(2)}`,
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "live",
    pageUrl: "https://app.example.com/",
    pageTitle: "Example",
    viewportWidth: 1280,
    viewportHeight: 800,
  });
});

function attach(runId: string | null = session.runId) {
  const socket = fakeSocket();
  attachViewerSocket({
    sessionId: session.id,
    companyId,
    employeeId: employee.id,
    runId,
    ws: socket.ws,
    userId: "user-1",
  });
  socket.drain(); // discard the hello / viewer-count preamble
  return socket;
}

describe("live viewer navigation", () => {
  test("a viewer who has not taken control cannot navigate", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.navigate", url: "https://app.example.com/settings" });
    assert.deepEqual(socket.drain(), []);
  });

  test("a viewer who has not taken control cannot use back / forward / reload", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.history", action: "back" });
    assert.deepEqual(socket.drain(), []);
  });

  test("take-over does not lift the employee's host allow list", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: true });
    socket.drain();

    await socket.deliver({ type: "control.navigate", url: "https://elsewhere.test/" });
    const [msg] = socket.drain();
    assert.equal(msg?.type, "nav.error");
    assert.match(String(msg?.message), /elsewhere\.test/);
    assert.match(String(msg?.message), /allow list/i);
  });

  test("schemes that reach past the host check are refused before anything else", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: true });
    socket.drain();

    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "about:blank",
      "data:text/html,<h1>x</h1>",
      "view-source:https://app.example.com/",
    ]) {
      await socket.deliver({ type: "control.navigate", url });
      const [msg] = socket.drain();
      // Refused before the browser is ever consulted — the message differs by
      // how far each one gets through parsing, but none of them navigate.
      assert.equal(msg?.type, "nav.error", url);
      assert.doesNotMatch(String(msg?.message), /no longer running/i, url);
    }
  });

  test("an allowed host clears policy and reaches the browser", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: true });
    socket.drain();

    await socket.deliver({ type: "control.navigate", url: "app.example.com/settings" });
    const [msg] = socket.drain();
    // No Chromium is running in this test, so getting *this* error is the
    // proof the URL passed every policy gate ahead of it.
    assert.equal(msg?.type, "nav.error");
    assert.match(String(msg?.message), /no longer running/i);
  });

  test("releasing control locks navigation again", async () => {
    const socket = attach();
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: true });
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: false });
    socket.drain();

    await socket.deliver({ type: "control.navigate", url: "https://app.example.com/" });
    assert.deepEqual(socket.drain(), []);
  });

  test("Run finalization rejects a new live-view browser mutation", async () => {
    const runId = `viewer-finalizing-${Date.now()}`;
    const socket = attach(runId);
    await socket.deliver({ type: "control.takeover", userId: "self", takeover: true });
    socket.drain();
    markBrowserRecordingRunFinalizing(runId);
    try {
      await socket.deliver({ type: "control.navigate", url: "https://app.example.com/settings" });
    } finally {
      releaseBrowserRecordingRunFinalizing(runId);
    }

    const [msg] = socket.drain();
    assert.equal(msg?.type, "nav.error");
    assert.match(String(msg?.message), /finalizing/i);
  });
});
