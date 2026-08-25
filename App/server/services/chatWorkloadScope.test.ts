import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { chatWorkloadScopeKey } from "./chat.js";
import { EMPLOYEE_WIDE_SCOPE } from "./workloadLeases.js";

/**
 * Which chat-seam turns serialize against which thread.
 *
 * The reply lease stops two turns replaying the *same* transcript from racing.
 * Scoping it to the thread is what lets one AI Employee answer several
 * conversations at once instead of making a Member queue behind whichever
 * chat they happened to send first.
 *
 * The interesting exception is a Repository work session started from chat:
 * the conversation that called `start_repository_work_session` is still
 * holding its own lease when the session begins, so the session must take no
 * lease at all rather than deadlock against the turn that started it.
 */

describe("chat reply serialization", () => {
  test("an ordinary chat turn serializes on its conversation", () => {
    assert.equal(chatWorkloadScopeKey({ conversationId: "conv_1" }), "conversation:conv_1");
  });

  test("two conversations with one employee never contend", () => {
    assert.notEqual(
      chatWorkloadScopeKey({ conversationId: "conv_1" }),
      chatWorkloadScopeKey({ conversationId: "conv_2" }),
    );
  });

  test("the per-email assistant serializes on its email thread", () => {
    assert.equal(chatWorkloadScopeKey({ mailThreadId: "thread_1" }), "mail-thread:thread_1");
  });

  test("a surface with its own thread names it explicitly", () => {
    assert.equal(
      chatWorkloadScopeKey({ workloadScope: "tldr-question:q_1", conversationId: "conv_1" }),
      "tldr-question:q_1",
    );
  });

  test("a surface with no thread falls back to one employee-wide lease", () => {
    // A real sentinel, never NULL: NULL on the row means "written by a build
    // from before threads were scoped", which the lease treats as blocking
    // everything so a rolling upgrade cannot race two turns in one thread.
    assert.equal(chatWorkloadScopeKey({}), EMPLOYEE_WIDE_SCOPE);
    assert.equal(chatWorkloadScopeKey({ conversationId: undefined }), EMPLOYEE_WIDE_SCOPE);
    assert.notEqual(EMPLOYEE_WIDE_SCOPE, null);
  });

  test("both Todo surfaces name the same thread", () => {
    // A kickoff (`todoKickoff.ts`) and an @-mention reply (`routes/projects.ts`)
    // replay the same Todo comment thread, so they are the one pair here that
    // genuinely must not answer it at once. Scoping only one of them would
    // have quietly removed the serialization they actually need.
    assert.equal(chatWorkloadScopeKey({ workloadScope: "todo:todo_1" }), "todo:todo_1");
    assert.notEqual(
      chatWorkloadScopeKey({ workloadScope: "todo:todo_1" }),
      chatWorkloadScopeKey({ workloadScope: "todo:todo_2" }),
    );
  });

  test("a Repository work session takes no reply lease at all", () => {
    assert.equal(chatWorkloadScopeKey({ repositoryWorkSessionId: "session_1" }), undefined);
    assert.equal(
      chatWorkloadScopeKey({ repositoryWorkSessionId: "session_1", conversationId: "conv_1" }),
      undefined,
    );
  });
});

/**
 * Every chat-seam caller that replays a transcript must name the thread it
 * replays.
 *
 * This is not a style rule. A caller that hands the seam a history but no
 * scope lands on the employee-wide lease, which no longer serializes against
 * the thread-scoped turns answering that same transcript — so two replies can
 * race and the second answers a history missing the first. Two surfaces were
 * already found in exactly that state (the Todo kickoff and workspace channel
 * replies), which is why this is pinned in source rather than left to review.
 *
 * A caller passing a literal `[]` has no transcript and is deliberately exempt.
 */
describe("every transcript-replaying caller names its thread", () => {
  const SERVER_ROOT = path.resolve(import.meta.dirname, "..");
  /** The scope-bearing option names `chatWorkloadScopeKey` actually reads. */
  const NAMES_A_THREAD = /\b(workloadScope|conversationId|mailThreadId|repositoryWorkSessionId)\b/;

  function callerFiles(): string[] {
    const out = execFileSync(
      "grep",
      ["-rlE", "--include=*.ts", "(stream)?[cC]hatWithEmployee\\(", SERVER_ROOT],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("/services/chat.ts"));
  }

  test("no caller replays a history onto the employee-wide lease", () => {
    const offenders: string[] = [];
    for (const file of callerFiles()) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/\b(?:stream)?[cC]hatWithEmployee\(/g)) {
        // The call runs to the closing paren of its options object; scanning a
        // generous window past the call keeps this robust to formatting.
        const call = source.slice(match.index, match.index + 1400);
        const history = /,\s*\[\]\s*,/.test(call.slice(0, 400));
        if (history) continue;
        if (NAMES_A_THREAD.test(call.slice(0, 900))) continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${path.relative(SERVER_ROOT, file)}:${line}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these callers replay a transcript but name no thread, so their replies " +
        "can race the thread-scoped turns answering the same history",
    );
  });

  test("the scan can actually see the callers it is guarding", () => {
    // Without this the suite would pass by finding nothing at all.
    const files = callerFiles().map((f) => path.relative(SERVER_ROOT, f));
    assert.ok(files.length >= 5, `expected several chat-seam callers, saw ${files.length}`);
    for (const expected of ["services/todoKickoff.ts", "services/workspaceChat.ts"]) {
      assert.ok(files.includes(expected), `the scan missed ${expected}`);
    }
  });
});
