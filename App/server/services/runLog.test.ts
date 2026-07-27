import assert from "node:assert/strict";
import test from "node:test";
import { DurableRunLog } from "./runLog.js";

test("checkpoints the live transcript and flushes the newest content on stop", async () => {
  const checkpoints: string[] = [];
  let resolveFirstCheckpoint: (() => void) | null = null;
  const firstCheckpoint = new Promise<void>((resolve) => {
    resolveFirstCheckpoint = resolve;
  });
  const log = new DurableRunLog({
    checkpointEveryMs: 10,
    persist: async (content) => {
      checkpoints.push(content);
      resolveFirstCheckpoint?.();
      resolveFirstCheckpoint = null;
    },
  });

  log.line("run started");
  log.write("working");
  await firstCheckpoint;

  assert.deepEqual(checkpoints, ["run started\nworking"]);

  log.line(" on the report");
  await log.stopCheckpointing();

  assert.equal(checkpoints.at(-1), "run started\nworking on the report\n");
});

test("serializes checkpoints so an older slow snapshot cannot overwrite a newer one", async () => {
  let persisted = "";
  let writes = 0;
  const log = new DurableRunLog({
    persist: async (content) => {
      writes += 1;
      if (writes === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      persisted = content;
    },
  });

  log.write("first");
  const first = log.flush();
  log.write(" second");
  await log.stopCheckpointing();
  await first;

  assert.equal(writes, 2);
  assert.equal(persisted, "first second");
});

test("keeps the transcript bounded while checkpointing the truncation marker", async () => {
  let persisted = "";
  const log = new DurableRunLog({
    cap: 5,
    persist: async (content) => {
      persisted = content;
    },
  });

  log.write("123456789");
  await log.stopCheckpointing();

  assert.equal(log.isTruncated, true);
  assert.match(persisted, /^12345\n\[truncated/);
});
