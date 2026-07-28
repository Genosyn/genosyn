import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createChatTurnProgressRecorder } from "./chatTurnProgress.js";

describe("chat turn progress recorder", () => {
  test("persists milestones in order and forwards them immediately", async () => {
    const persisted: number[] = [];
    const forwarded: number[] = [];
    const repository = {
      update: async (
        _criteria: unknown,
        patch: { progressPercent?: number | null },
      ) => {
        await Promise.resolve();
        persisted.push(patch.progressPercent ?? 0);
        return { generatedMaps: [], raw: [], affected: 1 };
      },
    };
    const recorder = createChatTurnProgressRecorder({
      repository,
      messageId: "message-1",
      onProgress: (progress) => forwarded.push(progress.percent),
    });

    recorder.report({ percent: 15, label: "Inspecting records" });
    recorder.report({ percent: 70, label: "Verifying changes" });

    assert.deepEqual(forwarded, [15, 70]);
    assert.deepEqual(persisted, []);
    await recorder.flush();
    assert.deepEqual(persisted, [15, 70]);
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
      onPersistenceError: (error) => errors.push(error),
    });

    recorder.report({ percent: 25, label: "Still working" });
    await recorder.flush();

    assert.equal(errors.length, 1);
  });
});
