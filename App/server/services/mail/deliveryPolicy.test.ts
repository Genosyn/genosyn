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
      assert.match(mailDeliveryToolError("draft", "send_mail", args)!, /preparation only/);
    }
    for (const tool of [
      "send_invoice",
      "send_estimate",
      "send_signature_envelope",
      "remind_signature_recipient",
    ]) {
      assert.ok(mailDeliveryToolError("draft", tool), tool);
    }
    assert.equal(mailDeliveryToolError("draft", "create_mail_draft"), null);
    assert.equal(mailDeliveryToolError("reply", "send_mail"), null);
    assert.equal(mailDeliveryToolError(null, "send_mail"), null);
  });

  test("triage cannot compose through either mail surface; draft mode may compose", () => {
    assert.ok(mailDeliveryToolError("triage", "create_mail_draft"));
    assert.ok(mailDeliveryToolError("triage", "edit_mail_draft"));
    assert.equal(mailDeliveryToolError("triage", "update_mail_thread"), null);
    assert.throws(() => assertMailDeliveryCapability("draft", "mail.send"), /preparation only/);
    assert.throws(() => assertMailDeliveryCapability("triage", "mail.draft"), /triage only/);
    assert.doesNotThrow(() => assertMailDeliveryCapability("draft", "mail.draft"));
    assert.doesNotThrow(() => assertMailDeliveryCapability("triage", "mail.read"));
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
    }
    assert.ok(mailDeliveryToolError("draft", "create_recurring_invoice", { autoSend: true }));
    assert.equal(
      mailDeliveryToolError("draft", "create_recurring_invoice", { autoSend: false }),
      null,
    );
    assert.ok(
      mailDeliveryToolError("draft", "update_recurring_invoice", { notes: "New terms" }),
    );
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
});
