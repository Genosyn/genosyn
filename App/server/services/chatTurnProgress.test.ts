import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createChatTurnProgressRecorder,
  createProgressRefreshNotifier,
  createReplyTextSnapshotter,
} from "./chatTurnProgress.js";

describe("progress refresh notifier", () => {
  test("leads immediately and trails with the newest suppressed milestone", async () => {
    const notifiedAt: number[] = [];
    const notifier = createProgressRefreshNotifier({
      notify: () => notifiedAt.push(Date.now()),
      intervalMs: 20,
    });

    notifier.report();
    notifier.report();
    notifier.report();
    assert.equal(notifiedAt.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(notifiedAt.length, 2);
    notifier.cancel();
  });

  test("cancels a trailing refresh and contains subscriber errors", async () => {
    let attempts = 0;
    const notifier = createProgressRefreshNotifier({
      notify: () => {
        attempts += 1;
        throw new Error("socket closed");
      },
      intervalMs: 20,
    });

    assert.doesNotThrow(() => notifier.report());
    notifier.report();
    notifier.cancel();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(attempts, 1);
  });
});

describe("chat turn progress recorder", () => {
  test("persists milestones in order and forwards them immediately", async () => {
    const persisted: number[] = [];
    const persistedEvents: number[] = [];
    const forwarded: number[] = [];
    const repository = {
      update: async (_criteria: unknown, patch: { progressPercent?: number | null }) => {
        await Promise.resolve();
        persisted.push(patch.progressPercent ?? 0);
        return { generatedMaps: [], raw: [], affected: 1 };
      },
    };
    const recorder = createChatTurnProgressRecorder({
      repository,
      messageId: "message-1",
      onProgress: (progress) => forwarded.push(progress.percent),
      onPersisted: (progress) => persistedEvents.push(progress.percent),
    });

    recorder.report({ percent: 15, label: "Inspecting records" });
    recorder.report({ percent: 70, label: "Verifying changes" });

    assert.deepEqual(forwarded, [15, 70]);
    assert.deepEqual(persisted, []);
    assert.deepEqual(persistedEvents, []);
    await recorder.flush();
    assert.deepEqual(persisted, [15, 70]);
    assert.deepEqual(persistedEvents, [15, 70]);
  });

  test("only announces milestones that still belong to the working turn", async () => {
    const persistedEvents: number[] = [];
    const recorder = createChatTurnProgressRecorder({
      repository: {
        update: async () => ({ generatedMaps: [], raw: [], affected: 0 }),
      },
      messageId: "message-overtaken",
      onPersisted: (progress) => persistedEvents.push(progress.percent),
    });

    recorder.report({ percent: 55, label: "Overtaken work" });
    await recorder.flush();

    assert.deepEqual(persistedEvents, []);
  });

  test("contains subscriber and persistence failures", async () => {
    const errors: unknown[] = [];
    const recorder = createChatTurnProgressRecorder({
      repository: {
        update: async () => {
          throw new Error("database unavailable");
        },
      },
      messageId: "message-2",
      onProgress: () => {
        throw new Error("stream closed");
      },
      onPersisted: () => {
        throw new Error("socket closed");
      },
      onPersistenceError: (error) => errors.push(error),
    });

    recorder.report({ percent: 25, label: "Still working" });
    await recorder.flush();

    assert.equal(errors.length, 1);
  });

  test("contains live-refresh subscriber failures after a successful write", async () => {
    const errors: unknown[] = [];
    const recorder = createChatTurnProgressRecorder({
      repository: {
        update: async () => ({ generatedMaps: [], raw: [], affected: 1 }),
      },
      messageId: "message-3",
      onPersisted: () => {
        throw new Error("socket closed");
      },
      onPersistenceError: (error) => errors.push(error),
    });

    recorder.report({ percent: 80, label: "Finishing" });
    await recorder.flush();

    assert.deepEqual(errors, []);
  });
});

describe("reply text snapshots", () => {
  type Update = { where: Record<string, unknown>; patch: Record<string, unknown> };
  function fakeRepository(affected = 1) {
    const updates: Update[] = [];
    return {
      updates,
      repository: {
        update: async (where: unknown, patch: unknown) => {
          updates.push({
            where: where as Record<string, unknown>,
            patch: patch as Record<string, unknown>,
          });
          return { affected, raw: [], generatedMaps: [] };
        },
      },
    };
  }

  test("saves the newest text at most once per interval, only on this worker's working row", async () => {
    const { updates, repository } = fakeRepository();
    const snapshot = createReplyTextSnapshotter({
      repository: repository as never,
      messageId: "m1",
      workerId: "w1",
      intervalMs: 30,
    });
    snapshot.report("H");
    snapshot.report("He");
    snapshot.report("Hello");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(updates.length, 1, "a leading write");
    assert.deepEqual(updates[0], {
      where: { id: "m1", status: "working", turnWorkerId: "w1" },
      patch: { content: "Hello" },
    });
    snapshot.report("Hello there");
    snapshot.report("Hello there!");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, 1, "nothing again inside the interval");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await snapshot.flush();
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1].patch, { content: "Hello there!" });
    snapshot.cancel();
  });

  test("an unchanged text is not written twice, and a cancel stops every later write", async () => {
    const { updates, repository } = fakeRepository();
    const snapshot = createReplyTextSnapshotter({
      repository: repository as never,
      messageId: "m1",
      workerId: "w1",
      intervalMs: 10,
    });
    snapshot.report("Same");
    await new Promise((resolve) => setTimeout(resolve, 20));
    snapshot.report("Same");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(updates.length, 1);
    snapshot.report("Later");
    snapshot.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(updates.length, 1);
  });

  test("a failed save is reported, never thrown into the turn", async () => {
    const errors: unknown[] = [];
    const snapshot = createReplyTextSnapshotter({
      repository: {
        update: async () => {
          throw new Error("database is locked");
        },
      } as never,
      messageId: "m1",
      workerId: "w1",
      intervalMs: 5,
      onPersistenceError: (error) => errors.push(error),
    });
    snapshot.report("text");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await snapshot.flush();
    assert.equal(errors.length, 1);
    snapshot.cancel();
  });
});
