import assert from "node:assert/strict";
import { test } from "node:test";
import { HUMAN_DECISION_GUIDANCE } from "../humanDecisionGuidance.js";
import {
  PROACTIVE_REVIEW_BRIEF,
  proactiveReviewToolError,
  proactiveReviewToolScope,
} from "./workReviewPolicy.js";

test("ordinary customer preparation does not require another human work review", () => {
  const preparation: Array<[string, Record<string, unknown>]> = [
    ["create_contact", { name: "James Barnett", email: "james@example.test", source: "inbound" }],
    ["update_contact", { contactId: "contact", name: "James Barnett", title: "Founder" }],
    ["update_deal", { dealId: "deal", nextStep: "Clarify evaluation scope", nextFollowUpAt: null }],
    [
      "log_activity",
      { kind: "note", contactId: "contact", bodyText: "Active evaluation confirmed." },
    ],
    [
      "create_follow_up",
      { subject: "Check evaluation response", contactId: "contact", dueAt: "2026-09-24" },
    ],
    ["update_follow_up", { followUpId: "follow-up", status: "completed" }],
    [
      "create_workstream",
      { title: "Customer evaluation", stateDoc: "Reply awaits human sending." },
    ],
    [
      "update_workstream",
      { workstreamId: "workstream", stateDoc: "Saved the verified Contact facts." },
    ],
    ["update_mail_thread", { threadId: "thread", markRead: true, archive: true }],
  ];
  const scope = proactiveReviewToolScope(true)!;
  for (const [name, args] of preparation) {
    assert.equal(proactiveReviewToolError(true, name, args), null, name);
    assert.ok(scope.genosynTools.includes(name), name);
  }
  assert.ok(PROACTIVE_REVIEW_BRIEF.includes(HUMAN_DECISION_GUIDANCE));
  assert.match(PROACTIVE_REVIEW_BRIEF, /Do not add a work review merely to prepare that email/);
});

test("preparation cannot change financial terms, ownership, consent or delivery authority", () => {
  const excessive: Array<[string, Record<string, unknown>]> = [
    ["create_contact", { name: "James", lifecycleStage: "customer" }],
    ["update_contact", { contactId: "contact", email: "different@example.test" }],
    ["update_contact", { contactId: "contact", doNotContact: false }],
    ["update_contact", { contactId: "contact", ownerEmployeeId: "another-employee" }],
    ["update_contact", { contactId: "contact", customerId: "another-account" }],
    ["update_deal", { dealId: "deal", amountCents: 20_000 }],
    ["update_deal", { dealId: "deal", currency: "USD" }],
    ["update_deal", { dealId: "deal", followUpReminderAt: "2026-09-24" }],
    ["log_activity", { kind: "call", bodyText: "Claiming a call happened" }],
    ["log_activity", { kind: "task", subject: "Schedule follow-up" }],
    ["create_follow_up", { subject: "Follow up", recurrenceRule: "FREQ=DAILY" }],
    ["update_follow_up", { followUpId: "follow-up", reminderAt: "2026-09-24" }],
    ["create_follow_up", { subject: "Follow up", assignedEmployeeId: "another-employee" }],
    ["update_mail_thread", { threadId: "thread", addLabels: ["TRASH"] }],
    ["update_mail_thread", { threadId: "thread", removeLabels: ["SPAM"] }],
    ["create_workstream", { title: "Work", employeeId: "another-employee" }],
    ["update_workstream", { workstreamId: "workstream", routineId: "broader-routine" }],
  ];
  for (const [name, args] of excessive)
    assert.ok(proactiveReviewToolError(true, name, args), `${name}: ${JSON.stringify(args)}`);
});

test("new preparation parameters fail closed without narrowing ordinary authorized work", () => {
  for (const name of [
    "create_contact",
    "update_contact",
    "update_deal",
    "log_activity",
    "create_follow_up",
    "update_follow_up",
    "create_workstream",
    "update_workstream",
    "update_mail_thread",
  ]) {
    const args = { kind: "note", futurePrivilegedParameter: true };
    assert.ok(proactiveReviewToolError(true, name, args), name);
    assert.equal(proactiveReviewToolError(false, name, args), null, name);
    assert.equal(proactiveReviewToolError(undefined, name, args), null, name);
  }
});

test("major work and side effects stay outside the preparation tool surface", () => {
  const scope = proactiveReviewToolScope(true)!;
  assert.equal(scope.surfaceOnly, true);
  assert.equal(scope.discovery, true);
  for (const name of [
    "send_mail",
    "create_mail_draft",
    "move_deal_stage",
    "start_repository_work_session",
    "schedule_wakeup",
    "enroll_in_sequence",
    "delete_contact",
    "mail_block_sender",
    "delegate_parallel_work",
    "bash",
    "browser_navigate",
    "external_send_message",
  ]) {
    assert.ok(proactiveReviewToolError(true, name), name);
    assert.ok(!scope.genosynTools.includes(name), name);
  }
  assert.equal(proactiveReviewToolScope(false), undefined);
  assert.equal(proactiveReviewToolError(true, "request_mail_review"), null);
  assert.equal(proactiveReviewToolError(true, "request_work_review"), null);
  assert.equal(proactiveReviewToolError(true, "request_decision"), null);
});
