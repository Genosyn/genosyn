import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AssistantChatSession,
  type AssistantChatAdapter,
  type AssistantChatMessage,
  type AssistantQueuedMessage,
} from "./assistantChatSessions.js";

type Message = AssistantChatMessage;
type RosterEntry = { id: string };
type OnEvent = (event: string, data: unknown) => void;

function message(
  id: string,
  role: Message["role"],
  content: string,
  status: Message["status"] = null,
): Message {
  return {
    id,
    role,
    content,
    status,
    employeeId: role === "assistant" ? "employee" : null,
    attachments: [],
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Session did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function harness() {
  const rows: Message[] = [];
  const calls: {
    item: AssistantQueuedMessage;
    emit: OnEvent;
    finish: () => void;
    fail: (error: Error) => void;
    signal: AbortSignal;
  }[] = [];
  let loadError = false;
  let loads = 0;
  let clears = 0;
  const adapter: AssistantChatAdapter<Message, RosterEntry> = {
    load: async () => {
      loads += 1;
      if (loadError) throw new Error("Offline");
      return {
        messages: rows.map((row) => ({ ...row })),
        roster: [{ id: "employee" }],
        modelId: "model-default",
      };
    },
    send: (item, emit, signal) =>
      new Promise<void>((finish, fail) => {
        calls.push({ item, emit, finish, fail, signal });
      }),
    clear: async () => {
      rows.length = 0;
      clears += 1;
    },
    createUserMessage: (item) => ({
      ...message(`temp-${item.id}`, "user", item.message),
      attachments: item.attachments,
    }),
    initialTarget: () => ({ id: "employee", name: "Jamie", slug: "jamie" }),
  };
  const session = new AssistantChatSession(adapter, 4);
  function accept(index: number) {
    const call = calls[index];
    const user = {
      ...message(`user-${index}`, "user", call.item.message),
      attachments: call.item.attachments,
    };
    const working = message(`assistant-${index}`, "assistant", "", "working");
    rows.push(user, working);
    call.emit("user", user);
    call.emit("working", working);
  }
  function finish(index: number, status: Message["status"] = "ok", emit = true) {
    const final = message(`assistant-${index}`, "assistant", "Finished", status);
    const rowIndex = rows.findIndex((row) => row.id === final.id);
    if (rowIndex === -1) rows.push(final);
    else rows[rowIndex] = final;
    if (emit) calls[index].emit("assistant", final);
    calls[index].finish();
  }
  return {
    rows,
    calls,
    adapter,
    session,
    accept,
    finish,
    setOffline: (value: boolean) => {
      loadError = value;
    },
    loads: () => loads,
    clears: () => clears,
  };
}

describe("assistant panel follow-up sessions", () => {
  test("serializes fast submissions and snapshots attachments, employee, model and focused draft", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    const attachment = {
      id: "attachment",
      filename: "form.pdf",
      mimeType: "application/pdf",
      sizeBytes: 15,
      isImage: false,
    };
    const input = {
      message: "Second",
      attachments: [attachment],
      employeeId: "jamie",
      modelId: "model-chosen",
      focusedMessageId: "draft-chosen",
    };
    h.session.send(input);
    input.modelId = "changed-model";
    attachment.filename = "changed.pdf";
    input.attachments.length = 0;
    await until(() => h.calls.length === 1);
    assert.equal(h.session.getSnapshot().queuedMessages.length, 1);
    h.accept(0);
    h.finish(0);
    await until(() => h.calls.length === 2);
    assert.equal(h.calls[1].item.modelId, "model-chosen");
    assert.equal(h.calls[1].item.employeeId, "jamie");
    assert.equal(h.calls[1].item.focusedMessageId, "draft-chosen");
    assert.equal(h.calls[1].item.attachments[0].filename, "form.pdf");
    h.accept(1);
    h.finish(1);
    await until(() => !h.session.getSnapshot().streamOpen);
    assert.deepEqual(
      h.session.getSnapshot().messages?.map((row) => row.id),
      ["user-0", "assistant-0", "user-1", "assistant-1"],
    );
  });

  test("closing a panel keeps its own stream and queue alive without affecting another conversation", async (t) => {
    const first = harness();
    const second = harness();
    t.after(() => {
      first.session.dispose();
      second.session.dispose();
    });
    const close = first.session.open();
    first.session.send({ message: "Original email", attachments: [] });
    first.session.send({ message: "Follow up on original email", attachments: [] });
    await until(() => first.calls.length === 1);
    first.accept(0);
    close();
    second.session.open();
    second.session.send({ message: "Another email", attachments: [] });
    await until(() => second.calls.length === 1);
    assert.equal(first.calls[0].signal.aborted, false);
    first.finish(0);
    await until(() => first.calls.length === 2);
    assert.equal(first.calls[1].item.message, "Follow up on original email");
    assert.equal(second.calls.length, 1);
  });

  test("recovers a final reply missed by the stream before draining the next message", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    h.session.send({ message: "Second", attachments: [] });
    await until(() => h.calls.length === 1);
    // Server accepted and completed before the browser received any events.
    h.rows.push(message("user-0", "user", "First"));
    h.rows.push(message("assistant-0", "assistant", "Finished", "ok"));
    h.calls[0].fail(new Error("Connection closed"));
    await until(() => h.calls.length === 2);
    assert.equal(
      h.calls[1].item.message,
      "Second",
      "the accepted first message must never be re-posted",
    );
    assert.equal(
      h.session.getSnapshot().messages?.filter((row) => row.content === "First").length,
      1,
    );
  });

  test("holds follow-ups through an outage until its accepted reply can be read", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    h.session.send({ message: "Second", attachments: [] });
    await until(() => h.calls.length === 1);
    h.accept(0);
    h.setOffline(true);
    h.calls[0].fail(new Error("Connection dropped"));
    await until(() => h.loads() >= 3);
    assert.equal(h.calls.length, 1);
    assert.equal(h.session.getSnapshot().reconnecting, true);
    h.finish(0, "ok", false);
    h.setOffline(false);
    await until(() => h.calls.length === 2);
    assert.equal(h.calls[1].item.message, "Second");
  });

  test("a failed reply pauses the queue until an explicit continuation, and waiting messages can be removed", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    h.session.send({ message: "Remove me", attachments: [] });
    h.session.send({ message: "Keep me", attachments: [] });
    await until(() => h.calls.length === 1);
    h.accept(0);
    h.finish(0, "error");
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    assert.equal(h.calls.length, 1);
    h.session.removeQueuedMessage(h.session.getSnapshot().queuedMessages[0].id);
    h.session.resumeQueue();
    await until(() => h.calls.length === 2);
    assert.equal(h.calls[1].item.message, "Keep me");
  });

  test("an unconfirmed send preserves the whole queued payload for review without automatic retry", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [], modelId: "chosen" });
    h.session.send({ message: "Second", attachments: [] });
    await until(() => h.calls.length === 1);
    h.calls[0].fail(new Error("Network failure before confirmation"));
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(
      h.session.getSnapshot().queuedMessages.map((item) => item.message),
      ["First", "Second"],
    );
    assert.equal(h.session.getSnapshot().queuedMessages[0].modelId, "chosen");
    assert.match(h.session.getSnapshot().queuePaused!, /avoid repeating work/);
    assert.deepEqual(h.session.getSnapshot().messages, []);
  });

  test("an older identical message cannot confirm acceptance of a new dropped request", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.rows.push(
      message("old-user", "user", "Repeat this"),
      message("old-assistant", "assistant", "Previous reply", "ok"),
    );
    h.session.send({ message: "Repeat this", attachments: [] });
    h.session.send({ message: "Later message", attachments: [] });
    await until(() => h.calls.length === 1);
    h.calls[0].fail(new Error("Disconnected before confirmation"));
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(
      h.session.getSnapshot().queuedMessages.map((item) => item.message),
      ["Repeat this", "Later message"],
    );
    assert.deepEqual(
      h.session.getSnapshot().messages?.map((row) => row.id),
      ["old-user", "old-assistant"],
    );
  });

  test("a deliberately submitted recovery message continues an otherwise empty paused queue", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    await until(() => h.calls.length === 1);
    h.accept(0);
    h.finish(0, "error");
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    h.session.send({ message: "Try a different approach", attachments: [] });
    await until(() => h.calls.length === 2);
    assert.equal(h.calls[1].item.message, "Try a different approach");
    assert.equal(h.session.getSnapshot().queuePaused, null);
  });

  test("retrying a failed predecessor runs before its waiting followers", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "Prepare the draft", attachments: [] });
    h.session.send({ message: "Review the draft", attachments: [] });
    await until(() => h.calls.length === 1);
    h.accept(0);
    h.finish(0, "error");
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    h.session.retry({
      message: "Prepare the draft",
      attachments: [],
      employeeId: "employee",
      modelId: "original-model",
    });
    await until(() => h.calls.length === 2);
    assert.equal(h.calls[1].item.message, "Prepare the draft");
    assert.equal(h.calls[1].item.modelId, "original-model");
    assert.equal(h.session.getSnapshot().queuedMessages[0].message, "Review the draft");
    h.accept(1);
    h.finish(1);
    await until(() => h.calls.length === 3);
    assert.equal(h.calls[2].item.message, "Review the draft");
  });

  test("submitting during a cached panel refresh waits for the authoritative running turn", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    const close = h.session.open();
    await until(() => !h.session.getSnapshot().loading);
    close();
    let resolveRefresh!: (value: Awaited<ReturnType<typeof h.adapter.load>>) => void;
    let refreshed = false;
    h.session.setAdapter({
      ...h.adapter,
      load: () => {
        if (refreshed) return h.adapter.load();
        refreshed = true;
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
    });
    h.session.open();
    assert.equal(h.session.getSnapshot().loading, true);
    h.session.send({ message: "Follow up", attachments: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.calls.length, 0);
    h.rows.push(
      message("external-user", "user", "Started elsewhere"),
      message("external-assistant", "assistant", "", "working"),
    );
    resolveRefresh({ messages: h.rows.map((row) => ({ ...row })), roster: [], modelId: null });
    await until(() => h.loads() >= 2);
    assert.equal(h.calls.length, 0);
    h.rows[1] = message("external-assistant", "assistant", "Finished", "ok");
    await until(() => h.calls.length === 1);
    assert.equal(h.calls[0].item.message, "Follow up");
  });

  test("an older refresh snapshot cannot replace a newer persisted message update", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.rows.push(message("assistant-old", "assistant", "Original reply", "ok"));
    const close = h.session.open();
    await until(() => !h.session.getSnapshot().loading);
    close();
    let resolveRefresh!: (value: Awaited<ReturnType<typeof h.adapter.load>>) => void;
    h.session.setAdapter({
      ...h.adapter,
      load: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    });
    h.session.open();
    h.session.updateMessage(message("assistant-old", "assistant", "Updated reply", "ok"));
    resolveRefresh({ messages: [...h.rows], roster: [], modelId: null });
    await until(() => !h.session.getSnapshot().loading);
    assert.equal(h.session.getSnapshot().messages?.[0].content, "Updated reply");
  });

  test("an employee selection changed while a message waits survives that queued turn's target event", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [], employeeId: "employee" });
    h.session.send({ message: "Queued for Jamie", attachments: [], employeeId: "employee" });
    await until(() => h.calls.length === 1);
    h.accept(0);
    h.session.setTarget({ id: "next-employee", name: "Next", slug: "next" });
    h.finish(0);
    await until(() => h.calls.length === 2);
    h.calls[1].emit("target", { employee: { id: "employee", name: "Jamie", slug: "jamie" } });
    assert.equal(h.calls[1].item.employeeId, "employee");
    assert.equal(h.session.getSnapshot().target?.id, "next-employee");
  });

  test("follows a previously running reply before sending and pauses if that reply fails", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.rows.push(
      message("old-user", "user", "Already running"),
      message("old-assistant", "assistant", "", "working"),
    );
    h.session.open();
    h.session.send({ message: "Follow up", attachments: [] });
    await until(() => h.loads() >= 2);
    assert.equal(h.calls.length, 0);
    h.rows[1] = message("old-assistant", "assistant", "Failed", "error");
    await until(() => Boolean(h.session.getSnapshot().queuePaused));
    assert.equal(h.calls.length, 0);
    h.session.resumeQueue();
    await until(() => h.calls.length === 1);
    assert.equal(h.calls[0].item.message, "Follow up");
  });

  test("clearing cannot delete an active reply or a waiting follow-up", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    await until(() => h.calls.length === 1);
    await assert.rejects(h.session.clear(), /Wait for the current reply/);
    assert.equal(h.clears(), 0);
    h.accept(0);
    h.finish(0);
    await until(() => !h.session.getSnapshot().streamOpen);
    await h.session.clear();
    assert.equal(h.clears(), 1);
    assert.deepEqual(h.session.getSnapshot().messages, []);
  });

  test("late target and bootstrap results do not overwrite the next message's employee or model selection", async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    h.session.send({ message: "First", attachments: [] });
    await until(() => h.calls.length === 1);
    h.session.setTarget({ id: "next-employee", name: "Next", slug: "next" });
    h.session.setModelId("next-model");
    h.calls[0].emit("target", { employee: { id: "employee", name: "Jamie", slug: "jamie" } });
    h.accept(0);
    h.calls[0].fail(new Error("Dropped stream"));
    await until(() => h.loads() >= 2);
    assert.equal(h.session.getSnapshot().target?.id, "next-employee");
    assert.equal(h.session.getSnapshot().modelId, "next-model");
  });
});
