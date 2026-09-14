import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { issueMcpToken, resolveMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { assertMailDeliveryCapability, mailDeliveryToolError } from "./deliveryPolicy.js";

describe("handover delivery authority", () => {
  test("rejects every native email delivery form independently of model arguments", () => {
    for (const args of [
      { draftMessageId: "draft" },
      { threadId: "thread", bodyText: "reply" },
      { to: "customer@example.com", bodyText: "new" },
    ]) {
      assert.match(mailDeliveryToolError("draft", "send_mail", args)!, /request_mail_review/);
    }
    for (const tool of [
      "send_invoice",
      "send_estimate",
      "send_signature_envelope",
      "remind_signature_recipient",
    ]) {
      assert.ok(mailDeliveryToolError("draft", tool), tool);
    }
    assert.match(mailDeliveryToolError("draft", "create_mail_draft")!, /Decision stack/);
    assert.match(mailDeliveryToolError("draft", "edit_mail_draft")!, /Decision stack/);
    assert.equal(mailDeliveryToolError("draft", "request_mail_review"), null);
    assert.equal(mailDeliveryToolError("reply", "send_mail"), null);
    assert.match(mailDeliveryToolError("reply", "create_mail_draft")!, /must not create/i);
    assert.match(mailDeliveryToolError("reply", "edit_mail_draft")!, /must not create/i);
    assert.equal(mailDeliveryToolError(null, "send_mail"), null);
  });

  test("triage cannot compose and legacy draft mode is stack-only review", () => {
    assert.ok(mailDeliveryToolError("triage", "create_mail_draft"));
    assert.ok(mailDeliveryToolError("triage", "edit_mail_draft"));
    assert.ok(mailDeliveryToolError("triage", "request_mail_review"));
    assert.ok(mailDeliveryToolError("triage", "revise_mail_review"));
    assert.equal(mailDeliveryToolError("triage", "update_mail_thread"), null);
    assert.throws(() => assertMailDeliveryCapability("draft", "mail.send"), /request_mail_review/);
    assert.throws(() => assertMailDeliveryCapability("triage", "mail.draft"), /triage only/);
    assert.throws(() => assertMailDeliveryCapability("draft", "mail.draft"), /Decision stack/);
    assert.throws(() => assertMailDeliveryCapability("reply", "mail.draft"), /must not create/i);
    assert.doesNotThrow(() => assertMailDeliveryCapability("triage", "mail.read"));
  });

  test("review mode keeps the exact reply in the Decision stack", () => {
    assert.match(mailDeliveryToolError("review", "send_mail")!, /request_mail_review/);
    assert.match(mailDeliveryToolError("review", "create_mail_draft")!, /Decision stack/);
    assert.match(mailDeliveryToolError("review", "edit_mail_draft")!, /Decision stack/);
    assert.equal(mailDeliveryToolError("review", "request_mail_review"), null);
    assert.doesNotThrow(() => assertMailDeliveryCapability("review", "mail.read"));
    assert.throws(() => assertMailDeliveryCapability("review", "mail.send"), /request_mail_review/);
    assert.throws(() => assertMailDeliveryCapability("review", "mail.draft"), /Decision stack/);
  });

  test("a restricted turn cannot shed its ceiling through another employee or timer", () => {
    for (const tool of [
      "schedule_wakeup",
      "create_handoff",
      "decide_decision",
      "create_routine",
      "update_routine",
      "create_pipeline",
      "run_pipeline",
      "enroll_in_sequence",
      "send_workspace_message",
    ]) {
      assert.ok(mailDeliveryToolError("draft", tool), tool);
      assert.ok(mailDeliveryToolError("reply", tool), `reply:${tool}`);
    }
    assert.ok(mailDeliveryToolError("draft", "create_recurring_invoice", { autoSend: true }));
    assert.ok(mailDeliveryToolError("reply", "create_recurring_invoice", { autoSend: true }));
    assert.equal(
      mailDeliveryToolError("draft", "create_recurring_invoice", { autoSend: false }),
      null,
    );
    assert.ok(mailDeliveryToolError("draft", "update_recurring_invoice", { notes: "New terms" }));
    assert.ok(mailDeliveryToolError("reply", "update_recurring_invoice", { notes: "New terms" }));
    assert.equal(
      mailDeliveryToolError("draft", "update_recurring_invoice", { autoSend: false }),
      null,
    );
    assert.equal(mailDeliveryToolError("draft", "create_workstream"), null);
    assert.equal(mailDeliveryToolError("draft", "propose_initiative"), null);
    assert.equal(mailDeliveryToolError("draft", "start_repository_work_session"), null);
  });

  test("tokens retain the server's delivery mode separately from employee authority", () => {
    const token = issueMcpToken("employee", "company", {
      authority: "employee",
      mailThreadId: "thread",
      mailDeliveryMode: "draft",
    });
    assert.equal(resolveMcpToken(token)?.mailDeliveryMode, "draft");
    assert.equal(resolveMcpToken(token)?.authority, "employee");
    revokeMcpToken(token);
    assert.equal(resolveMcpToken(token), null);
  });

  test("tokens retain the stack-only review delivery mode", () => {
    const token = issueMcpToken("employee", "company", {
      authority: "employee",
      mailThreadId: "thread",
      mailDeliveryMode: "review",
    });
    assert.equal(resolveMcpToken(token)?.mailDeliveryMode, "review");
    revokeMcpToken(token);
  });
});
