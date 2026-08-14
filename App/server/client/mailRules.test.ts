import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CATCH_ALL_UNSUBSCRIBE_ERROR,
  cleanMailRuleActions,
  cleanMailRuleConditions,
  compactRuleText,
  mailRuleSummaryParts,
  ruleEmployeeOptions,
  validateUnsubscribeRuleScope,
  type RuleEmployeeCandidate,
} from "../../client/lib/mailRules.js";
import type { MailRuleConditions } from "../../client/lib/mail.js";

describe("mail rule AI employee eligibility", () => {
  test("accepts every mailbox grant level when the AI employee has a connected model", () => {
    const employees: RuleEmployeeCandidate[] = [
      { id: "read", name: "Reader", model: { model: "gpt-read", status: "connected" } },
      { id: "draft", name: "Drafter", model: { model: "gpt-draft", status: "connected" } },
      { id: "send", name: "Sender", model: { model: "gpt-send", status: "connected" } },
    ];

    const options = ruleEmployeeOptions(employees, [
      { employeeId: "read", accessLevel: "read" },
      { employeeId: "draft", accessLevel: "draft" },
      { employeeId: "send", accessLevel: "send" },
    ]);

    assert.deepEqual(
      options.map(({ eligible, detail }) => ({ eligible, detail })),
      [
        { eligible: true, detail: "Read access · gpt-read" },
        { eligible: true, detail: "Draft access · gpt-draft" },
        { eligible: true, detail: "Send access · gpt-send" },
      ],
    );
  });

  test("explains missing mailbox access and connected models", () => {
    const employees: RuleEmployeeCandidate[] = [
      { id: "no-grant", name: "No grant", model: { model: "gpt", status: "connected" } },
      { id: "no-model", name: "No model", model: null },
      {
        id: "disconnected",
        name: "Disconnected",
        model: { model: "gpt", status: "not_connected" },
      },
      { id: "neither", name: "Neither" },
    ];

    const options = ruleEmployeeOptions(employees, [
      { employeeId: "no-model", accessLevel: "read" },
      { employeeId: "disconnected", accessLevel: "draft" },
    ]);

    assert.deepEqual(
      options.map(({ eligible, detail }) => ({ eligible, detail })),
      [
        { eligible: false, detail: "no mailbox access" },
        { eligible: false, detail: "no connected model" },
        { eligible: false, detail: "no connected model" },
        { eligible: false, detail: "no mailbox access · no connected model" },
      ],
    );
  });
});

describe("mail rule condition normalization", () => {
  test("trims matching fields and never sends response-only AI employee names", () => {
    const cleaned = cleanMailRuleConditions({
      from: "  newsletter@example.com ",
      to: "   ",
      subjectContains: "  Weekly update  ",
      bodyContains: "\n promotion \t",
      hasAttachment: false,
      ai: {
        employeeId: "  employee-1  ",
        instruction: "  Decide whether this is marketing spam.  ",
        employeeName: "Jamie",
      },
    });

    assert.deepEqual(cleaned, {
      from: "newsletter@example.com",
      subjectContains: "Weekly update",
      bodyContains: "promotion",
      ai: {
        employeeId: "employee-1",
        instruction: "Decide whether this is marketing spam.",
      },
    });
    assert.equal("employeeName" in (cleaned.ai ?? {}), false);
  });

  test("retains a positive attachment filter", () => {
    assert.deepEqual(cleanMailRuleConditions({ hasAttachment: true }), { hasAttachment: true });
  });
});

describe("mail rule action normalization", () => {
  test("trims persisted fields and never resends hydrated AI employee names", () => {
    assert.deepEqual(
      cleanMailRuleActions([
        { type: "applyLabel", labelName: "  Newsletters  " },
        {
          type: "handToEmployee",
          employeeId: "employee-1",
          employeeName: "Jamie",
          instruction: "  Review this message.  ",
          mode: "draft",
        },
        { type: "unsubscribe" },
      ]),
      [
        { type: "applyLabel", labelName: "Newsletters" },
        {
          type: "handToEmployee",
          employeeId: "employee-1",
          instruction: "Review this message.",
          mode: "draft",
        },
        { type: "unsubscribe" },
      ],
    );
  });
});

describe("automatic unsubscribe rule scope", () => {
  const unsubscribe = [{ type: "unsubscribe" }] as const;

  test("rejects catch-all and whitespace-only rules", () => {
    assert.equal(validateUnsubscribeRuleScope({}, [...unsubscribe]), CATCH_ALL_UNSUBSCRIBE_ERROR);
    assert.equal(
      validateUnsubscribeRuleScope(
        {
          from: "  ",
          ai: { employeeId: "employee-1", instruction: "\n\t" },
        },
        [...unsubscribe],
      ),
      CATCH_ALL_UNSUBSCRIBE_ERROR,
    );
  });

  test("allows unsubscribe after any meaningful static or AI condition", () => {
    const scopedConditions: MailRuleConditions[] = [
      { from: "example.com" },
      { to: "newsletter@" },
      { subjectContains: "promotion" },
      { bodyContains: "sale" },
      { hasAttachment: true },
      { ai: { employeeId: "employee-1", instruction: "This is marketing spam" } },
    ];

    for (const conditions of scopedConditions) {
      assert.equal(validateUnsubscribeRuleScope(conditions, [...unsubscribe]), null);
    }
  });

  test("does not constrain rules without an unsubscribe action", () => {
    assert.equal(validateUnsubscribeRuleScope({}, [{ type: "archive" }]), null);
  });
});

describe("mail rule summaries", () => {
  test("keeps static filters, AI judgment, and actions concise and visible", () => {
    const summary = mailRuleSummaryParts(
      {
        from: "newsletter.example",
        hasAttachment: true,
        ai: {
          employeeId: "employee-1",
          employeeName: "Jamie",
          instruction: "  Decide   whether this is marketing spam.  ",
        },
      },
      [
        { type: "unsubscribe" },
        {
          type: "handToEmployee",
          employeeId: "employee-2",
          employeeName: "Morgan",
          instruction: "Review it",
          mode: "triage",
        },
      ],
    );

    assert.deepEqual(summary, {
      staticConditions: ['from contains "newsletter.example"', "has attachment"],
      ai: {
        employeeName: "Jamie",
        instruction: "Decide whether this is marketing spam.",
      },
      actions: ["unsubscribe safely", "hand to Morgan (triage)"],
    });
  });

  test("shortens long AI instructions with an ellipsis", () => {
    assert.equal(compactRuleText("  One   two three four  ", 12), "One two thr…");
  });
});
