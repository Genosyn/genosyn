import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createChatTurnContextUsageRecorder } from "./chatTurnContextUsage.js";

type ContextPatch = { contextTokens?: number | null; contextWindow?: number | null };

/** Collects every write the recorder makes, in order, without a database. */
function recordingRepository(persisted: ContextPatch[], criteria: unknown[] = []) {
  return {
    update: async (criterion: unknown, patch: ContextPatch) => {
      await Promise.resolve();
      criteria.push(criterion);
      persisted.push(patch);
      return { generatedMaps: [], raw: [], affected: 1 };
    },
  };
}

describe("chat turn context usage recorder", () => {
  test("persists readings in order and forwards them immediately", async () => {
    const persisted: ContextPatch[] = [];
    const forwarded: number[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository(persisted),
      messageId: "message-1",
      onContextUsage: (usage) => forwarded.push(usage.promptTokens),
    });

    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 92_000, contextWindow: 200_000, percent: 46 });

    // The subscriber sees it synchronously; the database write is queued.
    assert.deepEqual(forwarded, [40_000, 92_000]);
    assert.deepEqual(persisted, []);
    await recorder.flush();
    assert.deepEqual(persisted, [
      { contextTokens: 40_000, contextWindow: 200_000 },
      { contextTokens: 92_000, contextWindow: 200_000 },
    ]);
  });

  test("writes only when the reading actually moves", async () => {
    const persisted: ContextPatch[] = [];
    const forwarded: number[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository(persisted),
      messageId: "message-2",
      onContextUsage: (usage) => forwarded.push(usage.promptTokens),
    });

    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 41_000, contextWindow: 200_000, percent: 21 });
    await recorder.flush();

    // A hundred-step turn must not put a hundred UPDATEs on the chat table, but
    // the live subscriber still hears every reading.
    assert.deepEqual(forwarded, [40_000, 40_000, 40_000, 41_000]);
    assert.deepEqual(persisted, [
      { contextTokens: 40_000, contextWindow: 200_000 },
      { contextTokens: 41_000, contextWindow: 200_000 },
    ]);
  });

  test("treats a changed window as a change even at the same token count", async () => {
    const persisted: ContextPatch[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository(persisted),
      messageId: "message-3",
    });

    recorder.report({ promptTokens: 40_000, contextWindow: null, percent: null });
    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    await recorder.flush();

    assert.deepEqual(persisted, [
      { contextTokens: 40_000, contextWindow: null },
      { contextTokens: 40_000, contextWindow: 200_000 },
    ]);
  });

  test("guards every write against a row this worker no longer owns", async () => {
    const criteria: unknown[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository([], criteria),
      messageId: "message-4",
      workerId: "worker-a",
    });

    recorder.report({ promptTokens: 10, contextWindow: 100, percent: 10 });
    await recorder.flush();

    // Without `status: working` a late write could resurrect a gauge onto a
    // finalized reply; without `turnWorkerId` it could land on a turn another
    // process has since claimed.
    assert.deepEqual(criteria, [
      { id: "message-4", status: "working", turnWorkerId: "worker-a" },
    ]);
  });

  test("omits the worker guard when the caller has no claim to assert", async () => {
    const criteria: unknown[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository([], criteria),
      messageId: "message-5",
    });

    recorder.report({ promptTokens: 10, contextWindow: 100, percent: 10 });
    await recorder.flush();

    assert.deepEqual(criteria, [{ id: "message-5", status: "working" }]);
  });

  test("exposes the latest reading for the finalize patch", async () => {
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository([]),
      messageId: "message-6",
    });

    assert.equal(recorder.latest(), null);
    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 92_000, contextWindow: 200_000, percent: 46 });
    await recorder.flush();

    assert.deepEqual(recorder.latest(), {
      promptTokens: 92_000,
      contextWindow: 200_000,
      percent: 46,
    });
  });

  test("keeps latest current even for a repeat reading it did not persist", async () => {
    const persisted: ContextPatch[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: recordingRepository(persisted),
      messageId: "message-7",
    });

    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    recorder.report({ promptTokens: 40_000, contextWindow: 200_000, percent: 20 });
    await recorder.flush();

    assert.equal(persisted.length, 1);
    assert.equal(recorder.latest()?.promptTokens, 40_000);
  });

  test("contains subscriber and persistence failures", async () => {
    const errors: unknown[] = [];
    const recorder = createChatTurnContextUsageRecorder({
      repository: {
        update: async () => {
          throw new Error("database unavailable");
        },
      },
      messageId: "message-8",
      onContextUsage: () => {
        throw new Error("stream closed");
      },
      onPersistenceError: (error) => errors.push(error),
    });

    // Losing a gauge reading must never abort hours of employee work.
    recorder.report({ promptTokens: 10, contextWindow: 100, percent: 10 });
    await recorder.flush();

    assert.equal(errors.length, 1);
    assert.equal(recorder.latest()?.promptTokens, 10);
  });

  test("a failed write does not poison the writes after it", async () => {
    const persisted: ContextPatch[] = [];
    const errors: unknown[] = [];
    let attempts = 0;
    const recorder = createChatTurnContextUsageRecorder({
      repository: {
        update: async (_criteria: unknown, patch: ContextPatch) => {
          attempts += 1;
          if (attempts === 1) throw new Error("database unavailable");
          persisted.push(patch);
          return { generatedMaps: [], raw: [], affected: 1 };
        },
      },
      messageId: "message-9",
      onPersistenceError: (error) => errors.push(error),
    });

    recorder.report({ promptTokens: 10, contextWindow: 100, percent: 10 });
    recorder.report({ promptTokens: 20, contextWindow: 100, percent: 20 });
    await recorder.flush();

    assert.equal(errors.length, 1);
    assert.deepEqual(persisted, [{ contextTokens: 20, contextWindow: 100 }]);
  });
});
