import assert from "node:assert/strict";
import { test } from "node:test";
import { issueMcpToken, resolveMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { routineDeliveryPolicy } from "./policy.js";
import {
  SELF_REVIEW_GENOSYN_TOOLS,
  selfReviewToolError,
  selfReviewToolScope,
} from "./reviewPolicy.js";

test("review tools are explicit and reject writers, aliases, delegation and unknown tools", () => {
  for (const tool of SELF_REVIEW_GENOSYN_TOOLS) {
    assert.equal(selfReviewToolError(true, tool, { kind: "routine_body" }), null, tool);
  }
  for (const tool of [
    "update_skill",
    "create_skill",
    "delete_skill",
    "update_routine",
    "delete_routine",
    "create_routine",
    "send_mail",
    "create_mail_draft",
    "mail_block_sender",
    "mail_unsubscribe",
    "run_pipeline",
    "propose_initiative",
    "request_decision",
    "schedule_wakeup",
    "start_repository_work_session",
    "open_repository_work_session_pull_request",
    "delegate_parallel_work",
    "bash",
    "read_file",
    "browser_navigate",
    "memory",
    "mail",
    "call_tool",
    "find_tools",
    "future_unknown_tool",
  ]) {
    assert.match(selfReviewToolError(true, tool)!, /review can read/i, tool);
    assert.equal(selfReviewToolError(false, tool), null, tool);
  }
});

test("review proposals preserve the grading bar and only stage supported document revisions", () => {
  for (const kind of ["soul", "skill", "routine_body"]) {
    assert.equal(selfReviewToolError(true, "propose_revision", { kind }), null);
  }
  for (const kind of ["routine_criteria", "checks", "", undefined, null]) {
    assert.match(
      selfReviewToolError(true, "propose_revision", { kind })!,
      /acceptance criteria or Checks/,
    );
  }
});

test("review scope and token restrictions are independent of mail delivery settings", () => {
  assert.deepEqual(routineDeliveryPolicy({ mailDeliveryMode: null, selfReviewOnly: true }), {
    mailDeliveryMode: null,
    allowPrivilegedToolSources: false,
  });
  assert.deepEqual(routineDeliveryPolicy({ mailDeliveryMode: "draft", selfReviewOnly: true }), {
    mailDeliveryMode: "draft",
    allowPrivilegedToolSources: false,
  });
  const scope = selfReviewToolScope(true)!;
  assert.equal(scope.surfaceOnly, true);
  assert.deepEqual(scope.genosynTools, [...SELF_REVIEW_GENOSYN_TOOLS]);
  (scope.genosynTools as string[]).push("send_mail");
  assert.equal(selfReviewToolScope(true)!.genosynTools.includes("send_mail"), false);
  assert.equal(selfReviewToolScope(false), undefined);
  const token = issueMcpToken("employee", "company", {
    authority: "employee",
    runId: "review-run",
    routineId: "review-routine",
    selfReviewOnly: true,
  });
  assert.equal(resolveMcpToken(token)?.selfReviewOnly, true);
  assert.equal(resolveMcpToken(token)?.mailDeliveryMode, null);
  revokeMcpToken(token);
});
