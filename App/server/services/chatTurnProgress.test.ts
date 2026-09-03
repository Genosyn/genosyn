import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createChatTurnProgressRecorder,
  createProgressRefreshNotifier,
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
