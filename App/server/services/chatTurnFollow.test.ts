import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { ChatTurnActivityRecorder } from "./chatTurnActivity.js";
import { followChatTurn } from "./chatTurnFollow.js";
import { openLiveTurn, releaseLiveTurn } from "./chatTurnLive.js";

/**
 * Following a turn from a browser that did not start it: a reload, another
 * tab, a dropped connection. The promise is that the reader ends up with
 * exactly what the sending browser had — every event once, in order, the
 * reply text so far, then the final reply — whether the turn is running in
 * this process, elsewhere, or already over.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

type Frame = { event: string; data: Record<string, unknown> };

const SCOPE_BASE = { companyId: "co_follow", conversationId: "conv_follow" };

async function workingTurn(content = ""): Promise<ConversationMessage> {
  return insert(ConversationMessage, {
    conversationId: SCOPE_BASE.conversationId,
    role: "assistant",
    content,
    status: "working",
    turnAttempt: 1,
    turnDeadlineAt: new Date(Date.now() + 6 * 60 * 60_000),
  });
}

/** Start following, collecting frames, with a short poll for the remote path. */
function follow(messageId: string, after = 0) {
  const frames: Frame[] = [];
  const controller = new AbortController();
  const waiters: Array<{ match: (frames: Frame[]) => boolean; resolve: () => void }> = [];
  const done = followChatTurn({
    messageId,
    after,
    signal: controller.signal,
    pollMs: 20,
    heartbeatMs: 60_000,
    send: (event, data) => {
      frames.push({ event, data: (data ?? {}) as Record<string, unknown> });
      for (const waiter of [...waiters]) {
        if (waiter.match(frames)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    loadFinal: async (message) => ({
      id: message.id,
      status: message.status,
      content: message.content,
    }),
  });
  const until = (match: (frames: Frame[]) => boolean) =>
    match(frames)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error(`timed out; frames: ${JSON.stringify(frames.map((f) => f.event))}`)),
            5_000,
          );
          waiters.push({
            match,
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
          });
        });
  return { frames, controller, done, until };
}

const activityOrdinals = (frames: Frame[]) =>
  frames.filter((frame) => frame.event === "activity").map((frame) => frame.data.ordinal as number);

describe("following a chat turn", () => {
  test("a finished turn replays what the reader has not seen, then the final reply", async () => {
    const message = await workingTurn();
    const recorder = new ChatTurnActivityRecorder(
      { ...SCOPE_BASE, messageId: message.id, attempt: 1 },
      1,
    );
    recorder.turnStarted("start");
    recorder.toolUse("bash", { command: "ls" }, "c");
    recorder.toolResult("bash", { content: "a" }, "c");
    await recorder.flush();
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id },
      { status: "ok", content: "All done." },
    );

    const reader = follow(message.id, 1);
    await reader.done;
    assert.deepEqual(
      reader.frames.map((frame) => frame.event),
      ["turn", "activity", "activity", "assistant", "done"],
    );
    assert.deepEqual(activityOrdinals(reader.frames), [2, 3], "nothing at or before the cursor");
    assert.equal(reader.frames[0].data.messageId, message.id);
    assert.equal(typeof reader.frames[0].data.now, "string");
    assert.deepEqual(reader.frames[3].data, { id: message.id, status: "ok", content: "All done." });
  });

  test("a turn running here hands over exactly: no gap, no repeat, text as it streams", async () => {
    const message = await workingTurn();
    const live = openLiveTurn(message.id, SCOPE_BASE.conversationId);
    const recorder = new ChatTurnActivityRecorder(
      { ...SCOPE_BASE, messageId: message.id, attempt: 1 },
      1,
      {
        live,
      },
    );
    recorder.turnStarted("start");
    recorder.toolUse("search_web", { query: "spot" }, "c1");
    live.appendText("Looking ");
    await recorder.flush();

    const reader = follow(message.id, 0);
    await reader.until((frames) => frames.some((frame) => frame.event === "snapshot"));
    assert.deepEqual(activityOrdinals(reader.frames), [1, 2]);
    assert.equal(reader.frames.find((frame) => frame.event === "snapshot")?.data.text, "Looking ");

    recorder.toolResult("search_web", { content: "3 results" }, "c1");
    live.appendText("it up.");
    live.progress({ percent: 60, label: "Comparing" });
    live.context({ promptTokens: 1_000, contextWindow: 4_000, percent: 25 });
    await reader.until((frames) => frames.some((frame) => frame.event === "context"));
    assert.deepEqual(activityOrdinals(reader.frames), [1, 2, 3]);
    assert.deepEqual(
      reader.frames.filter((frame) => frame.event === "chunk").map((frame) => frame.data.text),
      ["it up."],
    );
    assert.deepEqual(reader.frames.find((frame) => frame.event === "progress")?.data, {
      percent: 60,
      label: "Comparing",
    });
    assert.deepEqual(reader.frames.find((frame) => frame.event === "context")?.data, {
      tokens: 1_000,
      window: 4_000,
      percent: 25,
    });

    await recorder.flush();
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id },
      { status: "ok", content: "Looking it up." },
    );
    live.finish();
    releaseLiveTurn(live);
    await reader.done;
    assert.deepEqual(activityOrdinals(reader.frames), [1, 2, 3], "the final pass repeats nothing");
    assert.deepEqual(
      reader.frames.slice(-2).map((frame) => frame.event),
      ["assistant", "done"],
    );
  });

  test("a turn running elsewhere is followed through its saved rows and text", async () => {
    const message = await workingTurn("Half");
    const reader = follow(message.id, 0);
    await reader.until((frames) => frames.some((frame) => frame.event === "snapshot"));
    assert.equal(reader.frames.find((frame) => frame.event === "snapshot")?.data.text, "Half");

    // Another process records and saves as it works.
    const recorder = new ChatTurnActivityRecorder(
      { ...SCOPE_BASE, messageId: message.id, attempt: 1 },
      1,
    );
    recorder.toolUse("bash", { command: "date" }, "x");
    await recorder.flush();
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id },
      { content: "Half way", progressPercent: 50, progressLabel: "Halfway" },
    );
    await reader.until(
      (frames) => frames.filter((frame) => frame.event === "snapshot").length >= 2,
    );
    assert.deepEqual(activityOrdinals(reader.frames), [1]);
    assert.equal(
      reader.frames.filter((frame) => frame.event === "snapshot").at(-1)?.data.text,
      "Half way",
    );
    assert.deepEqual(reader.frames.find((frame) => frame.event === "progress")?.data, {
      percent: 50,
      label: "Halfway",
    });

    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id },
      { status: "error", content: "It failed." },
    );
    await reader.done;
    assert.equal(reader.frames.at(-2)?.event, "assistant");
    assert.equal(reader.frames.at(-2)?.data.status, "error");
  });

  test("a turn that stops running here falls back to the rows, and re-attaches when it returns", async () => {
    const message = await workingTurn();
    const first = openLiveTurn(message.id, SCOPE_BASE.conversationId);
    const reader = follow(message.id, 0);
    await reader.until((frames) => frames.some((frame) => frame.event === "snapshot"));
    // Waiting for another reply in its thread: no longer running here.
    first.detach();
    releaseLiveTurn(first);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Picked up again in this process.
    const second = openLiveTurn(message.id, SCOPE_BASE.conversationId);
    const recorder = new ChatTurnActivityRecorder(
      { ...SCOPE_BASE, messageId: message.id, attempt: 2 },
      1,
      {
        live: second,
      },
    );
    await reader.until(() => true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    recorder.turnStarted("start");
    second.appendText("Back.");
    await reader.until((frames) => frames.some((frame) => frame.event === "chunk"));
    assert.deepEqual(activityOrdinals(reader.frames), [1]);
    await recorder.flush();
    await AppDataSource.getRepository(ConversationMessage).update(
      { id: message.id },
      { status: "ok", content: "Back." },
    );
    second.finish();
    releaseLiveTurn(second);
    await reader.done;
    assert.deepEqual(
      reader.frames.slice(-2).map((frame) => frame.event),
      ["assistant", "done"],
    );
  });

  test("a reader that leaves stops being sent anything, and a missing reply says so", async () => {
    const message = await workingTurn();
    const live = openLiveTurn(message.id, SCOPE_BASE.conversationId);
    const reader = follow(message.id, 0);
    await reader.until((frames) => frames.some((frame) => frame.event === "snapshot"));
    reader.controller.abort();
    await reader.done;
    const count = reader.frames.length;
    live.appendText("after leaving");
    assert.equal(reader.frames.length, count);
    live.finish();
    releaseLiveTurn(live);

    const ghost = follow("00000000-0000-4000-8000-000000000000", 0);
    await ghost.done;
    assert.deepEqual(
      ghost.frames.map((frame) => frame.event),
      ["error"],
    );
  });
});
