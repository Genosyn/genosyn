import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { Company } from "../../db/entities/Company.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { encryptConnectionConfig } from "../integrations.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "./adapters.js";
import type { ChatSurfaceAdapter } from "./types.js";
import {
  activeChatSurfaceWorkerIds,
  bootChatSurfaceWorkers,
  refreshChatSurfaceWorker,
  stopChatSurfaceWorkers,
} from "./workers.js";

/**
 * Who holds a bot open, and who lets go.
 *
 * The failure this file is really guarding against is two loops on one bot:
 * Telegram answers a second poller with a 409, and two Slack sockets answer one
 * question twice. Everything below is a way of asking whether exactly one
 * worker exists at each moment, including across a token rotation and a delete.
 */

let company: Company;
let started = 0;
let cancelledCleanly = 0;

/** A transport that parks until cancelled, like a real long poll. */
function parkingAdapter(overrides: Partial<ChatSurfaceAdapter> = {}): ChatSurfaceAdapter {
  return {
    provider: "telegram",
    transport: "poll",
    textLimit: 4000,
    requiresPublicUrl: false,
    async send() {},
    async run({ isCancelled }) {
      started += 1;
      for (;;) {
        if (isCancelled()) {
          cancelledCleanly += 1;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    ...overrides,
  };
}

const webhookOnlyAdapter: ChatSurfaceAdapter = {
  provider: "whatsapp",
  transport: "webhook",
  textLimit: 4000,
  requiresPublicUrl: true,
  async send() {},
};

async function connection(provider: string): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId: company.id,
    provider,
    label: `${provider} bot`,
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig({ botToken: "t" }, company.id),
    accountHint: provider,
    status: "connected",
  });
}

/**
 * Wait for something to become true rather than for a fixed number of
 * milliseconds. A worker starts on its own microtask and then does a database
 * round trip before it reaches the transport, and a loaded CI runner is slower
 * at both than a laptop — a sleep long enough to be reliable there would be
 * dead time in every one of these tests.
 */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let anything already scheduled run, without asserting it happened. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

before(initTestDb);
after(async () => {
  await stopChatSurfaceWorkers();
  clearChatSurfaceAdapterOverridesForTests();
  await closeTestDb();
});

beforeEach(async () => {
  await stopChatSurfaceWorkers();
  await resetTestDb();
  started = 0;
  cancelledCleanly = 0;
  setChatSurfaceAdapterForTests("telegram", parkingAdapter());
  setChatSurfaceAdapterForTests("whatsapp", webhookOnlyAdapter);
  company = await insert(Company, { name: "Worker Co", slug: "worker-co", ownerId: "owner" });
});

afterEach(async () => {
  await stopChatSurfaceWorkers();
  clearChatSurfaceAdapterOverridesForTests();
});

describe("refreshChatSurfaceWorker", () => {
  test("starts a loop for a surface that holds a connection open", async () => {
    const conn = await connection("telegram");
    await refreshChatSurfaceWorker(conn.id);
    await waitFor(() => started === 1, "the transport to be entered");
    assert.deepEqual(activeChatSurfaceWorkerIds(), [conn.id]);
  });

  test("starts nothing for a webhook-only surface", async () => {
    const conn = await connection("whatsapp");
    await refreshChatSurfaceWorker(conn.id);
    await settle();
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
    assert.equal(started, 0);
  });

  test("starts nothing for a Connection that is not a chat surface at all", async () => {
    const conn = await connection("stripe");
    await refreshChatSurfaceWorker(conn.id);
    await settle();
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
  });

  test("is idempotent — a second call does not double the loop", async () => {
    const conn = await connection("telegram");
    await refreshChatSurfaceWorker(conn.id);
    await waitFor(() => started === 1, "the first transport");
    await refreshChatSurfaceWorker(conn.id);
    await waitFor(() => started === 2, "the replacement transport");
    assert.deepEqual(activeChatSurfaceWorkerIds(), [conn.id]);
    assert.equal(cancelledCleanly, 1, "the replaced loop was told to stop");
  });

  test("a deleted Connection stops its loop and leaves nothing behind", async () => {
    const conn = await connection("telegram");
    await refreshChatSurfaceWorker(conn.id);
    await waitFor(() => started === 1, "the transport to be entered");
    await refreshChatSurfaceWorker(conn.id, { deleted: true });
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
    assert.equal(cancelledCleanly, 1);
  });

  test("a Connection that vanished from the database starts nothing", async () => {
    const conn = await connection("telegram");
    await refreshChatSurfaceWorker(conn.id, { deleted: true });
    await settle();
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
  });

  test("two Connections on the same surface each get their own loop", async () => {
    const a = await connection("telegram");
    const b = await connection("telegram");
    await refreshChatSurfaceWorker(a.id);
    await refreshChatSurfaceWorker(b.id);
    await waitFor(() => started === 2, "both transports");
    assert.deepEqual(activeChatSurfaceWorkerIds(), [a.id, b.id].sort());
  });
});

describe("bootChatSurfaceWorkers", () => {
  test("adopts every long-running Connection already in the database", async () => {
    const tg = await connection("telegram");
    await connection("whatsapp");
    await connection("stripe");
    await bootChatSurfaceWorkers();
    await waitFor(() => started === 1, "the Telegram transport");
    assert.deepEqual(activeChatSurfaceWorkerIds(), [tg.id]);
  });

  test("booting twice does not leave two loops on one bot", async () => {
    const tg = await connection("telegram");
    await bootChatSurfaceWorkers();
    await waitFor(() => started === 1, "the transport");
    await bootChatSurfaceWorkers();
    await settle();
    assert.deepEqual(activeChatSurfaceWorkerIds(), [tg.id]);
    assert.equal(started, 1, "discovery adopted the running loop rather than adding one");
  });
});

describe("stopChatSurfaceWorkers", () => {
  test("cancels every loop and waits for them to unwind", async () => {
    await connection("telegram");
    await connection("telegram");
    await bootChatSurfaceWorkers();
    await waitFor(() => started === 2, "both transports");
    assert.equal(activeChatSurfaceWorkerIds().length, 2);
    await stopChatSurfaceWorkers();
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
    assert.equal(cancelledCleanly, 2, "each transport was told to stop, not abandoned");
  });

  test("is safe to call when nothing is running", async () => {
    await stopChatSurfaceWorkers();
    await stopChatSurfaceWorkers();
    assert.deepEqual(activeChatSurfaceWorkerIds(), []);
  });
});

describe("a transport that throws", () => {
  test("is logged and retried rather than taking the worker down", async () => {
    let attempts = 0;
    setChatSurfaceAdapterForTests(
      "telegram",
      parkingAdapter({
        async run() {
          attempts += 1;
          throw new Error("token revoked");
        },
      }),
    );
    const conn = await connection("telegram");
    await refreshChatSurfaceWorker(conn.id);
    await waitFor(() => attempts === 1, "the transport to throw");
    assert.deepEqual(
      activeChatSurfaceWorkerIds(),
      [conn.id],
      "the worker stays registered and backs off instead of disappearing",
    );
  });
});
