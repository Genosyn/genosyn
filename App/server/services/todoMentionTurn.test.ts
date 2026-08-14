import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildTodoMentionTurn } from "./todoMentionTurn.js";

describe("Project comment AI turn authority", () => {
  test("binds the prompt and history to the exact accepting Member comment", () => {
    const turn = buildTodoMentionTurn({
      requesterUserId: "member-1",
      employeeId: "employee-1",
      triggerCommentId: "member-trigger",
      comments: [
        {
          id: "earlier-member",
          authorUserId: "member-1",
          authorEmployeeId: null,
          body: "Earlier context",
          pending: false,
        },
        {
          id: "earlier-employee",
          authorUserId: null,
          authorEmployeeId: "employee-1",
          body: "Earlier answer",
          pending: false,
        },
        {
          id: "member-trigger",
          authorUserId: "member-1",
          authorEmployeeId: null,
          body: "Member request",
          pending: false,
        },
        {
          id: "later-admin",
          authorUserId: "admin-1",
          authorEmployeeId: null,
          body: "Later privileged request",
          pending: false,
        },
      ],
    });

    assert.deepEqual(turn, {
      message: "Member request",
      history: [
        { role: "user", content: "Earlier context" },
        { role: "assistant", content: "Earlier answer" },
      ],
    });
  });

  test("fails closed when the trigger is missing or belongs to another Member", () => {
    const comments = [
      {
        id: "other-trigger",
        authorUserId: "other-member",
        authorEmployeeId: null,
        body: "Do this",
        pending: false,
      },
    ];
    assert.equal(
      buildTodoMentionTurn({
        comments,
        triggerCommentId: "missing",
        requesterUserId: "member-1",
        employeeId: "employee-1",
      }),
      null,
    );
    assert.equal(
      buildTodoMentionTurn({
        comments,
        triggerCommentId: "other-trigger",
        requesterUserId: "member-1",
        employeeId: "employee-1",
      }),
      null,
    );
  });
});
