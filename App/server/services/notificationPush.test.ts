import assert from "node:assert/strict";
import { test } from "node:test";

import type { NotificationKind } from "../db/entities/Notification.js";
import { PUSHED_NOTIFICATION_KINDS } from "./notifications.js";

/**
 * Every notification lands in the bell; only some interrupt a person's phone.
 * This names every kind and which side of that line it falls on, so adding a
 * kind fails the typecheck here until someone decides whether it interrupts.
 */
const DELIVERY: Record<NotificationKind, "push" | "bell"> = {
  mention: "push",
  todo_review_requested: "push",
  approval_pending: "push",
  decision_pending: "push",
  mail_handover: "push",
  revenue_follow_up: "push",
  goal_achieved: "push",
  goal_missed: "push",
  goal_confirmation_pending: "push",
  budget_exhausted: "push",
  standdown_placed: "push",
  board_letter_ready: "push",
  recruiting_strong_match: "push",
  data_room_question: "push",
  group_discussion: "push",
  finance_review_ready: "bell",
  run_failed: "bell",
  run_off_goal: "bell",
  approval_stale: "bell",
  decision_stale: "bell",
  handoff_overdue: "bell",
  revision_pending: "bell",
  revision_stale: "bell",
  autonomy_revoked: "bell",
  initiative_pending: "bell",
  recruiting_application: "bell",
  data_room_visit: "bell",
};

test("pushes what needs a person now, and the events an owner hears at once", () => {
  for (const [kind, delivery] of Object.entries(DELIVERY)) {
    if (delivery !== "push") continue;
    assert.equal(PUSHED_NOTIFICATION_KINDS.has(kind as NotificationKind), true, kind);
  }
});

test("keeps the company's own work in the bell", () => {
  for (const [kind, delivery] of Object.entries(DELIVERY)) {
    if (delivery !== "bell") continue;
    assert.equal(PUSHED_NOTIFICATION_KINDS.has(kind as NotificationKind), false, kind);
  }
});

test("pushes no kind this table does not name", () => {
  for (const kind of PUSHED_NOTIFICATION_KINDS) assert.equal(DELIVERY[kind], "push", kind);
});
