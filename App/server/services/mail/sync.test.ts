import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun } from "../../db/entities/PipelineRun.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { encryptConnectionConfig } from "../integrations.js";
import type { GmailMessage } from "./gmailClient.js";
import { upsertGmailMessage } from "./store.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  parseBackfillCursor,
  queueAccountSync,
  serializeBackfillCursor,
  disconnectMailAccount,
  waitForAccountSync,
} from "./sync.js";
import {
  enqueueInboundAutomation,
  runMailAutomationQueuePass,
  waitForMailAutomation,
} from "./automationQueue.js";

const originalFetch = globalThis.fetch;

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function activeAccount(): Promise<MailAccount> {
  const companyId = "co_mail_sync_test";
  const connection = await insert(IntegrationConnection, {
    companyId,
    provider: "google",
    label: "Test Gmail",
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(
      {
        clientId: "client",
        clientSecret: "secret",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        email: "owner@example.com",
      },
      companyId,
    ),
  });
  return insert(MailAccount, {
    companyId,
    connectionId: connection.id,
    address: "owner@example.com",
    status: "active",
    historyId: "history-1",
    backfilledAt: new Date("2026-08-13T10:00:00Z"),
    lastSyncAt: new Date("2026-08-13T10:00:00Z"),
  });
}

async function waitForTerminal(accountId: string): Promise<MailAccount> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const account = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: accountId,
    });
    if (account.syncState === "succeeded" || account.syncState === "failed") return account;
    if (Date.now() >= deadline) throw new Error("sync did not reach a terminal state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gmailMessage(id: string, threadId: string): GmailMessage {
  return {
    id,
    threadId,
    labelIds: ["INBOX", "UNREAD"],
    snippet: `Snippet ${id}`,
    internalDate: "1786615200000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
    },
  };
}

describe("mail backfill cursor", () => {
  test("upgrades the original plain Gmail page token without losing it", () => {
    assert.deepEqual(parseBackfillCursor("gmail-page-2"), {
      version: 1,
      pageToken: "gmail-page-2",
      pendingThreadIds: null,
      nextPageToken: "",
      deferredThreadIds: [],
      threadAttempts: {},
      messageWork: {},
      hydrationQueue: [],
    });
  });

  test("round-trips an exact remaining-thread worklist", () => {
    const encoded = serializeBackfillCursor({
      version: 1,
      pageToken: "gmail-page-2",
      pendingThreadIds: ["thread-b", "thread-c"],
      nextPageToken: "gmail-page-3",
      deferredThreadIds: ["thread-slow"],
      threadAttempts: { "thread-slow": 2 },
      messageWork: {
        "thread-slow": {
          pendingMessageIds: ["message-slow"],
          messageAttempts: { "message-slow": 1 },
        },
      },
      hydrationQueue: [{ threadId: "thread-hydrate", messageId: "message-hydrate", attempts: 3 }],
    });

    assert.deepEqual(parseBackfillCursor(encoded), {
      version: 1,
      pageToken: "gmail-page-2",
      pendingThreadIds: ["thread-b", "thread-c"],
      nextPageToken: "gmail-page-3",
      deferredThreadIds: ["thread-slow"],
      threadAttempts: { "thread-slow": 2 },
      messageWork: {
        "thread-slow": {
          pendingMessageIds: ["message-slow"],
          messageAttempts: { "message-slow": 1 },
        },
      },
      hydrationQueue: [{ threadId: "thread-hydrate", messageId: "message-hydrate", attempts: 3 }],
    });
  });

  test("keeps an exhausted final page distinct from a page not yet listed", () => {
    const exhausted = parseBackfillCursor(
      serializeBackfillCursor({
        version: 1,
        pageToken: "",
        pendingThreadIds: [],
        nextPageToken: "",
        deferredThreadIds: [],
        threadAttempts: {},
        messageWork: {},
        hydrationQueue: [],
      }),
    );
    assert.deepEqual(exhausted.pendingThreadIds, []);
    assert.equal(parseBackfillCursor("").pendingThreadIds, null);
  });

  test("recovers a corrupt versioned cursor instead of sending it to Gmail", () => {
    assert.deepEqual(parseBackfillCursor("{not-json"), {
      version: 1,
      pageToken: "",
      pendingThreadIds: null,
      nextPageToken: "",
      deferredThreadIds: [],
      threadAttempts: {},
      messageWork: {},
      hydrationQueue: [],
    });
  });
});

describe("mail sync lifecycle", () => {
  test("coalesces concurrent requests and records an explicit success", async () => {
    const account = await activeAccount();
    let labelsCalls = 0;
    let historyCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/labels")) {
        labelsCalls += 1;
        return json({ labels: [] });
      }
      if (url.includes("/history?")) {
        historyCalls += 1;
        return json({ history: [], historyId: "history-2" });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      queueAccountSync(account.id),
      queueAccountSync(account.id),
    ]);
    assert.equal(first.attemptId, second.attemptId);

    const finished = await waitForTerminal(account.id);
    assert.equal(finished.syncState, "succeeded");
    assert.equal(finished.status, "active");
    assert.equal(finished.statusMessage, "");
    assert.equal(finished.historyId, "history-2");
    assert.ok(finished.lastSyncAt);
    assert.ok(finished.syncStartedAt);
    assert.ok(finished.syncFinishedAt);
    assert.equal(labelsCalls, 1);
    assert.equal(historyCalls, 1);
  });

  test("records a terminal failure without changing last successful sync", async () => {
    const account = await activeAccount();
    const previousSuccess = account.lastSyncAt?.toISOString();
    globalThis.fetch = (async () =>
      json({ error: { message: "Access revoked" } }, 401)) as typeof fetch;

    const request = await queueAccountSync(account.id);
    const finished = await waitForTerminal(account.id);

    assert.equal(finished.syncAttemptId, request.attemptId);
    assert.equal(finished.syncState, "failed");
    assert.equal(finished.status, "error");
    assert.equal(finished.statusMessage, "Access revoked");
    assert.equal(finished.lastSyncAt?.toISOString(), previousSuccess);
    assert.ok(finished.syncFinishedAt);
  });

  test("does not repeat inbound rules or Pipelines when Gmail history replays", async () => {
    const account = await activeAccount();
    await insert(MailRule, {
      companyId: account.companyId,
      accountId: account.id,
      name: "Every inbound message",
      enabled: true,
      position: 0,
      conditionsJson: "{}",
      actionsJson: "[]",
      matchCount: 0,
      lastMatchedAt: null,
      createdByUserId: null,
    });
    await insert(Pipeline, {
      companyId: account.companyId,
      name: "Inbound replay test",
      slug: "inbound-replay-test",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: "email-trigger",
            type: "trigger.emailReceived",
            x: 0,
            y: 0,
            config: {},
          },
        ],
        edges: [],
      }),
      cronExpr: null,
      nextRunAt: null,
      lastRunAt: null,
      createdById: null,
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/history")) {
        return json({
          historyId: "history-2",
          history: [
            {
              id: "event-replay",
              messagesAdded: [{ message: { id: "message-replay", threadId: "thread-replay" } }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/messages/message-replay")) {
        if (url.searchParams.get("format") === "minimal") {
          return json({
            id: "message-replay",
            threadId: "thread-replay",
            labelIds: ["INBOX", "UNREAD"],
          });
        }
        return json(gmailMessage("message-replay", "thread-replay"));
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    for (let pass = 0; pass < 2; pass += 1) {
      await queueAccountSync(account.id);
      const finished = await waitForTerminal(account.id);
      assert.equal(finished.syncState, "succeeded");
      await waitForMailAutomation(account.id);
      // Rewind the cursor to reproduce Gmail replay after a crash/partial pass.
      await AppDataSource.getRepository(MailAccount).update(account.id, {
        historyId: "history-1",
      });
    }

    const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({
      accountId: account.id,
    });
    assert.equal(rule.matchCount, 1);
    assert.equal(await AppDataSource.getRepository(PipelineRun).count(), 1);
    const mirrored = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
      accountId: account.id,
      gmailMessageId: "message-replay",
    });
    const deliveries = await AppDataSource.getRepository(MailInboundAutomation).find({
      where: { accountId: account.id, gmailMessageId: mirrored.gmailMessageId },
    });
    assert.equal(deliveries.length, 1);
  });

  test("keeps inbound automation queued while paused and runs it after resume", async () => {
    const account = await activeAccount();
    const { row: message } = await upsertGmailMessage(
      account,
      gmailMessage("message-paused", "thread-paused"),
    );
    await insert(Pipeline, {
      companyId: account.companyId,
      name: "Paused inbound test",
      slug: "paused-inbound-test",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: "email-trigger",
            type: "trigger.emailReceived",
            x: 0,
            y: 0,
            config: {},
          },
        ],
        edges: [],
      }),
      cronExpr: null,
      nextRunAt: null,
      lastRunAt: null,
      createdById: null,
    });
    await AppDataSource.getRepository(MailAccount).update(account.id, { status: "paused" });

    await enqueueInboundAutomation(message);
    await waitForMailAutomation(account.id);
    const queued = await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
      accountId: account.id,
      gmailMessageId: message.gmailMessageId,
    });
    assert.equal(queued.status, "queued");
    assert.equal(await AppDataSource.getRepository(PipelineRun).count(), 0);

    await AppDataSource.getRepository(MailAccount).update(account.id, { status: "active" });
    await runMailAutomationQueuePass();
    await waitForMailAutomation(account.id);
    const delivered = await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
      id: queued.id,
    });
    assert.equal(delivered.status, "succeeded");
    assert.equal(await AppDataSource.getRepository(PipelineRun).count(), 1);
  });

  test("periodically closes an automation attempt stranded by a stopped app", async () => {
    const account = await activeAccount();
    const event = await insert(MailInboundAutomation, {
      companyId: account.companyId,
      accountId: account.id,
      messageId: "message-interrupted",
      gmailMessageId: "gmail-message-interrupted",
      status: "running",
      startedAt: new Date(Date.now() - 60 * 60 * 1_000),
      finishedAt: null,
      errorMessage: "",
    });

    await runMailAutomationQueuePass();
    assert.equal(
      (await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({ id: event.id }))
        .status,
      "running",
    );

    await AppDataSource.getRepository(MailInboundAutomation).update(event.id, {
      startedAt: new Date(Date.now() - 13 * 60 * 60 * 1_000),
    });
    await runMailAutomationQueuePass();
    const recovered = await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
      id: event.id,
    });
    assert.equal(recovered.status, "failed");
    assert.match(recovered.errorMessage, /app stopped/i);
    assert.ok(recovered.finishedAt);
  });

  test("removes a Gmail-deleted message when resuming inside a saved thread", async () => {
    const account = await activeAccount();
    await upsertGmailMessage(account, gmailMessage("message-gone", "thread-gone"));
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      backfilledAt: null,
      backfillPageToken: serializeBackfillCursor({
        version: 1,
        pageToken: "",
        pendingThreadIds: ["thread-gone"],
        nextPageToken: "",
        deferredThreadIds: [],
        threadAttempts: {},
        messageWork: {
          "thread-gone": {
            pendingMessageIds: ["message-gone"],
            messageAttempts: {},
          },
        },
        hydrationQueue: [],
      }),
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/history")) {
        return json({ history: [], historyId: "history-2" });
      }
      if (url.pathname.endsWith("/messages/message-gone")) {
        return json({ error: { message: "Not found" } }, 404);
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    const finished = await waitForTerminal(account.id);
    assert.equal(finished.syncState, "succeeded");
    assert.ok(finished.backfilledAt);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailThread).count(), 0);
  });

  test("defers one slow thread, imports later pages, and resumes it without duplicates", async () => {
    const account = await activeAccount();
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      historyId: "",
      backfilledAt: null,
      lastSyncAt: null,
    });
    let slowRecovered = false;

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "owner@example.com", historyId: "history-anchor" });
      }
      if (url.pathname.endsWith("/history")) {
        return json({ history: [], historyId: "history-after" });
      }
      if (url.pathname.endsWith("/threads")) {
        if (url.searchParams.get("pageToken") === "page-2") {
          return json({ threads: [{ id: "healthy-b" }] });
        }
        return json({
          threads: [{ id: "slow-thread" }, { id: "healthy-a" }],
          nextPageToken: "page-2",
        });
      }
      if (url.pathname.endsWith("/threads/slow-thread")) {
        if (url.searchParams.get("format") === "minimal") {
          return json({
            id: "slow-thread",
            messages: [{ id: "slow-message", threadId: "slow-thread" }],
          });
        }
        return slowRecovered
          ? json({ id: "slow-thread", messages: [gmailMessage("slow-message", "slow-thread")] })
          : Promise.reject(
              Object.assign(new Error("Large thread timed out"), { name: "TimeoutError" }),
            );
      }
      if (url.pathname.endsWith("/messages/slow-message")) {
        if (url.searchParams.get("format") === "metadata") {
          const message = gmailMessage("slow-message", "slow-thread");
          return json({
            ...message,
            payload: {
              mimeType: "text/plain",
              headers: message.payload?.headers,
            },
          });
        }
        return slowRecovered
          ? json(gmailMessage("slow-message", "slow-thread"))
          : Promise.reject(
              Object.assign(new Error("Large message timed out"), { name: "TimeoutError" }),
            );
      }
      if (url.pathname.endsWith("/threads/healthy-a")) {
        return json({ id: "healthy-a", messages: [gmailMessage("message-a", "healthy-a")] });
      }
      if (url.pathname.endsWith("/threads/healthy-b")) {
        return json({ id: "healthy-b", messages: [gmailMessage("message-b", "healthy-b")] });
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    const deferred = await waitForTerminal(account.id);
    assert.equal(deferred.syncState, "succeeded");
    assert.equal(deferred.backfilledAt, null);
    const deferredCursor = parseBackfillCursor(deferred.backfillPageToken);
    assert.deepEqual(deferredCursor.pendingThreadIds, ["slow-thread"]);
    assert.deepEqual(deferredCursor.messageWork["slow-thread"]?.pendingMessageIds, [
      "slow-message",
    ]);
    assert.equal(deferredCursor.messageWork["slow-thread"]?.messageAttempts["slow-message"], 1);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 3);

    slowRecovered = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await queueAccountSync(account.id);
    const completed = await waitForTerminal(account.id);
    assert.ok(completed.backfilledAt);
    assert.equal(completed.backfillPageToken, "");
    assert.equal(completed.backfilledCount, 3);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 3);
  });

  test("skips one vanished message without dropping the rest of a large thread", async () => {
    const account = await activeAccount();
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      historyId: "",
      backfilledAt: null,
      lastSyncAt: null,
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "owner@example.com", historyId: "history-anchor" });
      }
      if (url.pathname.endsWith("/threads")) {
        return json({ threads: [{ id: "large-thread" }] });
      }
      if (url.pathname.endsWith("/threads/large-thread")) {
        if (url.searchParams.get("format") === "minimal") {
          return json({
            id: "large-thread",
            messages: [
              { id: "vanished-message", threadId: "large-thread" },
              { id: "live-message", threadId: "large-thread" },
            ],
          });
        }
        return Promise.reject(
          Object.assign(new Error("Large thread timed out"), { name: "TimeoutError" }),
        );
      }
      if (url.pathname.endsWith("/messages/vanished-message")) {
        return json({ error: { message: "Not found" } }, 404);
      }
      if (url.pathname.endsWith("/messages/live-message")) {
        return json(gmailMessage("live-message", "large-thread"));
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    const finished = await waitForTerminal(account.id);
    assert.equal(finished.syncState, "succeeded");
    assert.ok(finished.backfilledAt);
    assert.equal(finished.backfilledCount, 1);
    const messages = await AppDataSource.getRepository(MailMessage).find();
    assert.deepEqual(
      messages.map((message) => message.gmailMessageId),
      ["live-message"],
    );
  });

  test("finishes with metadata and later hydrates a repeatedly slow body", async () => {
    const account = await activeAccount();
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      historyId: "",
      backfilledAt: null,
      lastSyncAt: null,
    });
    let bodyRecovered = false;

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "owner@example.com", historyId: "history-anchor" });
      }
      if (url.pathname.endsWith("/history")) {
        return json({ history: [], historyId: "history-after" });
      }
      if (url.pathname.endsWith("/threads")) {
        return json({ threads: [{ id: "slow-body-thread" }] });
      }
      if (url.pathname.endsWith("/threads/slow-body-thread")) {
        if (url.searchParams.get("format") === "minimal") {
          return json({
            id: "slow-body-thread",
            messages: [{ id: "slow-body-message", threadId: "slow-body-thread" }],
          });
        }
        return Promise.reject(
          Object.assign(new Error("Large thread timed out"), { name: "TimeoutError" }),
        );
      }
      if (url.pathname.endsWith("/messages/slow-body-message")) {
        if (url.searchParams.get("format") === "metadata") {
          const message = gmailMessage("slow-body-message", "slow-body-thread");
          return json({
            ...message,
            payload: { mimeType: "text/plain", headers: message.payload?.headers },
          });
        }
        return bodyRecovered
          ? json(gmailMessage("slow-body-message", "slow-body-thread"))
          : Promise.reject(
              Object.assign(new Error("Large message timed out"), { name: "TimeoutError" }),
            );
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    for (let pass = 0; pass < 3; pass += 1) {
      await queueAccountSync(account.id);
      await waitForTerminal(account.id);
      await waitForAccountSync(account.id);
    }
    const metadataOnly = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: account.id,
    });
    assert.ok(metadataOnly.backfilledAt);
    assert.equal(
      parseBackfillCursor(metadataOnly.backfillPageToken).hydrationQueue[0]?.messageId,
      "slow-body-message",
    );
    const partialMessage = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
      accountId: account.id,
      gmailMessageId: "slow-body-message",
    });
    assert.equal(partialMessage.bodyText, "");

    bodyRecovered = true;
    await queueAccountSync(account.id);
    const hydrated = await waitForTerminal(account.id);
    assert.equal(hydrated.syncState, "succeeded");
    assert.equal(hydrated.backfillPageToken, "");
    const fullMessage = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
      accountId: account.id,
      gmailMessageId: "slow-body-message",
    });
    assert.equal(fullMessage.bodyText, "Body slow-body-message");
  });

  test("does not resurrect mirror rows when the account is disconnected mid-fetch", async () => {
    const account = await activeAccount();
    await insert(Pipeline, {
      companyId: account.companyId,
      name: "Inbound test",
      slug: "inbound-test",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: "email-trigger",
            type: "trigger.emailReceived",
            x: 0,
            y: 0,
            config: {},
          },
        ],
        edges: [],
      }),
      cronExpr: null,
      nextRunAt: null,
      lastRunAt: null,
      createdById: null,
    });
    let releaseMessage!: () => void;
    const messageGate = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    let messageRequestedResolve!: () => void;
    const messageRequested = new Promise<void>((resolve) => {
      messageRequestedResolve = resolve;
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/history")) {
        return json({
          historyId: "history-2",
          history: [
            {
              id: "event-1",
              messagesAdded: [{ message: { id: "message-1", threadId: "thread-1" } }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/messages/message-1")) {
        messageRequestedResolve();
        await messageGate;
        return json(gmailMessage("message-1", "thread-1"));
      }
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    await messageRequested;
    const deleting = disconnectMailAccount(account);
    releaseMessage();
    await deleting;

    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
    assert.equal(await AppDataSource.getRepository(MailThread).count(), 0);
    assert.equal(await AppDataSource.getRepository(PipelineRun).count(), 0);
  });

  test("keeps a concurrent pause after the in-flight pass finishes", async () => {
    const account = await activeAccount();
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyRequestedResolve!: () => void;
    const historyRequested = new Promise<void>((resolve) => {
      historyRequestedResolve = resolve;
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/history")) {
        historyRequestedResolve();
        await historyGate;
        return json({ history: [], historyId: "history-2" });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    await historyRequested;
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      status: "paused",
      statusMessage: "",
    });
    releaseHistory();
    await waitForAccountSync(account.id);

    const finished = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: account.id,
    });
    assert.equal(finished.status, "paused");
    assert.equal(finished.syncState, "failed");
    assert.equal(finished.statusMessage, "");
  });

  test("a superseded attempt cannot purge the live mailbox mirror", async () => {
    const account = await activeAccount();
    await upsertGmailMessage(account, gmailMessage("message-kept", "thread-kept"));
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyRequestedResolve!: () => void;
    const historyRequested = new Promise<void>((resolve) => {
      historyRequestedResolve = resolve;
    });

    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/labels")) return json({ labels: [] });
      if (url.pathname.endsWith("/history")) {
        historyRequestedResolve();
        await historyGate;
        return json({ history: [], historyId: "history-2" });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;

    await queueAccountSync(account.id);
    await historyRequested;
    await AppDataSource.getRepository(MailAccount).update(account.id, {
      status: "active",
      syncState: "queued",
      syncAttemptId: "replacement-attempt",
      syncFinishedAt: null,
    });
    releaseHistory();
    await waitForAccountSync(account.id);

    const current = await AppDataSource.getRepository(MailAccount).findOneByOrFail({
      id: account.id,
    });
    assert.equal(current.syncAttemptId, "replacement-attempt");
    assert.equal(current.syncState, "queued");
    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 1);
    assert.equal(await AppDataSource.getRepository(MailThread).count(), 1);
  });

  test("metadata fallback preserves a body that was already mirrored", async () => {
    const account = await activeAccount();
    const full = gmailMessage("message-rich", "thread-rich");
    const { row } = await upsertGmailMessage(account, full);
    assert.equal(row.bodyText, "Body message-rich");

    await upsertGmailMessage(
      account,
      {
        id: full.id,
        threadId: full.threadId,
        labelIds: ["INBOX"],
        snippet: "Metadata-only update",
        internalDate: full.internalDate,
        payload: {
          mimeType: "text/plain",
          headers: full.payload?.headers,
        },
      },
      { preserveRichContent: true },
    );

    const preserved = await AppDataSource.getRepository(MailMessage).findOneByOrFail({
      id: row.id,
    });
    assert.equal(preserved.bodyText, "Body message-rich");
    assert.equal(preserved.snippet, "Metadata-only update");
  });
});
