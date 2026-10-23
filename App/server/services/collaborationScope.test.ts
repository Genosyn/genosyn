import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import {
  COLLABORATION_READ_TOOLS,
  collaborationToolError,
  collaborationToolScope,
} from "./collaborationScope.js";
import { TAINT_SINK_TOOLS, WEB_TAINT_SOURCES, APPLICANT_TAINT_SOURCES } from "./taintPolicy.js";

/**
 * A turn in which an AI Employee talks to colleagues — a group discussion
 * turn, or an answer to `ask_colleague` — can read and nothing else. These
 * pin the allowlist: every name is a real tool, none of them writes or
 * delivers, and the seam refuses everything else with words that turn a
 * refused action into a proposal.
 */

const READS = new Set<string>(COLLABORATION_READ_TOOLS);

describe("the collaboration allowlist", () => {
  test("every tool on it exists", () => {
    const manifest = new Set(STATIC_TOOLS.map((t) => t.name));
    const missing = COLLABORATION_READ_TOOLS.filter((name) => !manifest.has(name));
    assert.deepEqual(missing, []);
  });

  test("names no taint sink", () => {
    for (const name of TAINT_SINK_TOOLS) assert.equal(READS.has(name), false, name);
  });

  test("names nothing that writes, sends, schedules or delegates", () => {
    const writePrefixes = [
      "create_",
      "update_",
      "delete_",
      "send_",
      "archive_",
      "add_",
      "set_",
      "move_",
      "publish_",
      "close_",
      "issue_",
      "record_",
      "void_",
      "run_pipeline",
      "start_",
      "schedule_",
      "cancel_",
      "complete_",
      "decline_",
      "propose_",
      "request_",
      "decide_",
      "place_",
      "push_",
      "rename_",
      "merge_",
      "suppress_",
      "enroll_",
      "score_",
      "mark_",
      "save_",
      "fill_",
      "edit_",
      "attach_",
      "draft_",
      "remind_",
      "rotate_",
      "replace_",
      "rollback_",
      "undo_",
      "dismiss_",
      "review_",
      "log_",
      "link_",
      "mail_",
      "repository_",
    ];
    const writes = COLLABORATION_READ_TOOLS.filter((name) =>
      writePrefixes.some((prefix) => name.startsWith(prefix)),
    );
    assert.deepEqual(writes, []);
  });

  test("never lets a talking turn ask a colleague itself — talk is one hop deep", () => {
    assert.equal(READS.has("ask_colleague"), false);
    assert.equal(READS.has("send_workspace_message"), false);
    assert.equal(READS.has("create_handoff"), false);
  });

  test("keeps applicants' data out of group chats", () => {
    for (const name of APPLICANT_TAINT_SOURCES) assert.equal(READS.has(name), false, name);
  });

  test("allows the web readers, whose taint travels with what the turn writes", () => {
    for (const name of ["search_web", "fetch_web_page"]) {
      assert.equal(READS.has(name), true, name);
      assert.equal(WEB_TAINT_SOURCES.has(name), true, name);
    }
    assert.equal(READS.has("download_web_file"), false);
  });

  test("is listed once each", () => {
    assert.equal(READS.size, COLLABORATION_READ_TOOLS.length);
  });
});

describe("scope and seam", () => {
  const discussion = { kind: "discussion" as const, id: "d1" };
  const consult = { kind: "consult" as const, id: "c1" };

  test("an ordinary turn has no collaboration scope and no refusals", () => {
    assert.equal(collaborationToolScope(null), undefined);
    assert.equal(collaborationToolScope(undefined), undefined);
    assert.equal(collaborationToolError(null, "send_mail"), null);
  });

  test("a talking turn is surface-only, discoverable within the allowlist", () => {
    const scope = collaborationToolScope(discussion);
    assert.ok(scope);
    assert.equal(scope.surfaceOnly, true);
    assert.equal(scope.discovery, true);
    assert.deepEqual(scope.genosynTools, [...COLLABORATION_READ_TOOLS]);
  });

  test("the seam lets reads through and refuses writes with a proposal to make", () => {
    assert.equal(collaborationToolError(discussion, "get_deal"), null);
    const refusal = collaborationToolError(discussion, "send_mail");
    assert.match(refusal ?? "", /can read, not act/);
    assert.match(refusal ?? "", /who should do it/);
    assert.match(collaborationToolError(consult, "create_routine") ?? "", /answering a colleague/);
  });

  test("a path the seam cannot name is refused, never waved through", () => {
    assert.ok(collaborationToolError(discussion, null));
    assert.ok(collaborationToolError(consult, ""));
  });
});
