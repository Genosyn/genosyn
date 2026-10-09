import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CATEGORY_TONE_CLASSES,
  analysisActionBlockedReason,
  analysisActionConfirm,
  analysisActionDetail,
  analysisActionHint,
  analysisCategoryLabel,
  analysisCategoryTone,
  analysisEmployeeOptions,
  analysisInstructionsEdit,
  analysisReadinessNote,
  automaticActionNote,
  automaticActionTitle,
  automaticActionTone,
  automaticActionUndoable,
} from "../../client/lib/mailAnalysis.js";
import {
  MAIL_ANALYSIS_CATEGORIES,
  MAIL_ANALYSIS_FINANCE_KINDS,
  type MailAccessLevel,
  type MailAnalysisAction,
  type MailAnalysisAutoAction,
  type MailAssistantModel,
  type MailAssistantRosterEntry,
} from "../../client/lib/mail.js";
import type { FinanceAccess } from "../../client/lib/api.js";
import {
  MAIL_ANALYSIS_CATEGORIES as SERVER_MAIL_ANALYSIS_CATEGORIES,
  MAIL_ANALYSIS_FINANCE_KINDS as SERVER_MAIL_ANALYSIS_FINANCE_KINDS,
} from "../services/mail/analysis.js";
import {
  MAIL_ANALYSIS_AUTOMATIC_KINDS as SERVER_MAIL_ANALYSIS_AUTOMATIC_KINDS,
  autoActionUndoable as serverAutoActionUndoable,
} from "../services/mail/analysisAutomation.js";
import { DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS } from "../../shared/mailAnalysisInstructions.js";
import { financeAccessFor } from "../middleware/financeAccess.js";

function assistantModel(overrides: Partial<MailAssistantModel> = {}): MailAssistantModel {
  return {
    id: "model-1",
    provider: "anthropic",
    model: "claude-sonnet",
    isActive: true,
    ...overrides,
  };
}

function rosterEntry(overrides: Partial<MailAssistantRosterEntry> = {}): MailAssistantRosterEntry {
  return {
    id: "employee-1",
    name: "Jamie",
    slug: "jamie",
    role: "Support",
    avatarKey: null,
    accessLevel: "draft",
    hasModel: true,
    models: [assistantModel()],
    ...overrides,
  };
}

function analysisAction(
  kind: MailAnalysisAction["kind"],
  overrides: Partial<MailAnalysisAction> = {},
): MailAnalysisAction {
  return { id: `action-${kind}`, kind, label: "Model-authored label", ...overrides };
}

const ACTION_KINDS: MailAnalysisAction["kind"][] = [
  "draft_reply",
  "create_invoice",
  "create_estimate",
  "unsubscribe",
  "thread_action",
  "hand_over",
];

describe("analysis category labels", () => {
  test("names every category in the closed vocabulary", () => {
    assert.deepEqual(
      MAIL_ANALYSIS_CATEGORIES.map((category) => analysisCategoryLabel(category)),
      [
        "Invoice request",
        "Quote request",
        "Payment",
        "Support",
        "Sales lead",
        "Scheduling",
        "Vendor",
        "Recruiting",
        "Marketing",
        "Notification",
        "Internal",
        "Personal",
        "Spam",
        "Other",
      ],
    );
  });

  test("shows nothing for an absent category", () => {
    assert.equal(analysisCategoryLabel(""), "");
  });

  test("spells an unknown slug out as words rather than dropping the chip", () => {
    assert.equal(analysisCategoryLabel("wire_transfer_request"), "wire transfer request");
    assert.equal(analysisCategoryLabel("legal"), "legal");
  });
});

describe("analysis category tones", () => {
  test("falls back to slate for a category it does not know", () => {
    assert.equal(analysisCategoryTone("wire_transfer_request"), "slate");
    assert.equal(analysisCategoryTone(""), "slate");
  });

  test("makes the money categories emerald so they catch the eye", () => {
    assert.deepEqual(
      ["invoice_request", "quote_request", "payment"].map((category) =>
        analysisCategoryTone(category),
      ),
      ["emerald", "emerald", "emerald"],
    );
  });

  test("keeps noise categories quiet and flags spam", () => {
    assert.deepEqual(
      ["marketing", "notification", "internal", "personal", "spam"].map((category) =>
        analysisCategoryTone(category),
      ),
      ["slate", "slate", "slate", "slate", "red"],
    );
  });

  test("gives every category in the vocabulary a tone that has classes to render", () => {
    const unstyled = MAIL_ANALYSIS_CATEGORIES.filter(
      (category) => !(analysisCategoryTone(category) in CATEGORY_TONE_CLASSES),
    );
    assert.deepEqual(unstyled, []);
  });
});

describe("analysis action detail", () => {
  test("points a prepared reply to the Decision stack", () => {
    assert.equal(
      analysisActionDetail(analysisAction("draft_reply", { targetTo: "ada@example.com" })),
      "Owner/admin review in Needs you",
    );
    assert.equal(
      analysisActionDetail(analysisAction("draft_reply")),
      "Owner/admin review in Needs you",
    );
  });

  test("names the host an unsubscribe would talk to", () => {
    assert.equal(
      analysisActionDetail(analysisAction("unsubscribe", { targetHost: "lists.example.com" })),
      "via lists.example.com",
    );
    assert.equal(analysisActionDetail(analysisAction("unsubscribe")), null);
  });

  test("names the server-resolved employee for a handover, and what they will do", () => {
    // The mode is the risk being approved: triaging a thread and answering it
    // on the company's behalf are not the same click.
    assert.equal(
      analysisActionDetail(
        analysisAction("hand_over", {
          employeeId: "employee-2",
          targetEmployeeName: "Morgan",
          mode: "reply",
        }),
      ),
      "Morgan · replies for you",
    );
    assert.equal(
      analysisActionDetail(
        analysisAction("hand_over", {
          employeeId: "employee-2",
          targetEmployeeName: "Morgan",
          mode: "triage",
        }),
      ),
      "Morgan · triages it",
    );
    assert.equal(
      analysisActionDetail(
        analysisAction("hand_over", {
          employeeId: "employee-2",
          targetEmployeeName: "Morgan",
          mode: "draft",
        }),
      ),
      "Morgan · drafts a reply",
    );
    // No mode is still worth naming the employee for; no employee is not.
    assert.equal(
      analysisActionDetail(
        analysisAction("hand_over", { employeeId: "employee-2", targetEmployeeName: "Morgan" }),
      ),
      "Morgan",
    );
    assert.equal(
      analysisActionDetail(analysisAction("hand_over", { employeeId: "employee-2" })),
      null,
    );
  });

  test("shows only the label a thread action would apply", () => {
    assert.equal(
      analysisActionDetail(
        analysisAction("thread_action", { action: "applyLabel", labelName: "Receipts" }),
      ),
      "Receipts",
    );
    assert.equal(
      analysisActionDetail(analysisAction("thread_action", { action: "applyLabel" })),
      null,
    );
    assert.equal(
      analysisActionDetail(analysisAction("thread_action", { action: "archive" })),
      null,
    );
  });

  test("adds up what a money document would come to, with and without a customer", () => {
    for (const kind of ["create_invoice", "create_estimate"] as const) {
      assert.equal(
        analysisActionDetail(
          analysisAction(kind, { customerName: "Northwind Ltd", targetTotalCents: 125_000 }),
        ),
        "Northwind Ltd · $1,250.00",
      );
      assert.equal(
        analysisActionDetail(analysisAction(kind, { targetTotalCents: 4_999 })),
        "$49.99",
      );
    }
  });

  test("formats a non-USD total in its own currency", () => {
    assert.equal(
      analysisActionDetail(
        analysisAction("create_invoice", {
          customerName: "Northwind Ltd",
          targetTotalCents: 125_000,
          currency: "EUR",
        }),
      ),
      "Northwind Ltd · €1,250.00",
    );
    assert.equal(
      analysisActionDetail(
        analysisAction("create_estimate", { targetTotalCents: 4_999, currency: "GBP" }),
      ),
      "£49.99",
    );
  });

  test("falls back to the customer, then to nothing, when the server verified no total", () => {
    assert.equal(
      analysisActionDetail(analysisAction("create_invoice", { customerName: "Northwind Ltd" })),
      "Northwind Ltd",
    );
    assert.equal(analysisActionDetail(analysisAction("create_estimate")), null);
  });

  test("still shows a zero total rather than treating it as missing", () => {
    assert.equal(
      analysisActionDetail(analysisAction("create_invoice", { targetTotalCents: 0 })),
      "$0.00",
    );
  });
});

describe("analysis action hints", () => {
  test("says plainly what each kind of button does", () => {
    assert.deepEqual(
      ACTION_KINDS.map((kind) => analysisActionHint(analysisAction(kind))),
      [
        "Adds the reply to Needs you for an owner or admin to review — nothing is written to Gmail or IMAP Drafts",
        "Creates a draft invoice — no number, no ledger entry, nothing emailed",
        "Creates a draft estimate — nothing is sent to the customer",
        "Sends the sender's verified one-click unsubscribe request",
        "Applies the triage action to this thread",
        "Hands this thread to an AI employee to work",
      ],
    );
  });

  test("gives every kind its own non-empty hint", () => {
    const hints = ACTION_KINDS.map((kind) => analysisActionHint(analysisAction(kind)));
    assert.deepEqual(
      hints.filter((hint) => hint.trim().length === 0),
      [],
    );
    assert.equal(new Set(hints).size, ACTION_KINDS.length);
  });
});

describe("analysis action confirmations", () => {
  test("stops before telling a sender the address is live", () => {
    assert.deepEqual(
      analysisActionConfirm(analysisAction("unsubscribe", { targetHost: "lists.example.com" })),
      {
        title: "Unsubscribe from this sender?",
        message:
          "Genosyn will send the one-click unsubscribe request to lists.example.com. This confirms your address is real to that sender.",
        confirmLabel: "Unsubscribe",
      },
    );
  });

  test("omits the host from the unsubscribe warning when the server verified none", () => {
    assert.equal(
      analysisActionConfirm(analysisAction("unsubscribe"))?.message,
      "Genosyn will send the one-click unsubscribe request. This confirms your address is real to that sender.",
    );
  });

  test("repeats the verified total back before creating a draft invoice", () => {
    assert.deepEqual(
      analysisActionConfirm(
        analysisAction("create_invoice", {
          customerName: "Northwind Ltd",
          targetTotalCents: 125_000,
        }),
      ),
      {
        title: "Create a draft invoice?",
        message:
          "Northwind Ltd · $1,250.00 — it gets no number and posts nothing to the ledger until you issue it.",
        confirmLabel: "Create draft",
      },
    );
  });

  test("repeats the verified total back before creating a draft estimate", () => {
    assert.deepEqual(
      analysisActionConfirm(
        analysisAction("create_estimate", {
          customerName: "Northwind Ltd",
          targetTotalCents: 4_999,
        }),
      ),
      {
        title: "Create a draft estimate?",
        message: "Northwind Ltd · $49.99 — nothing is sent to the customer until you send it.",
        confirmLabel: "Create draft",
      },
    );
  });

  test("describes the document generically when there is nothing verified to show", () => {
    assert.equal(
      analysisActionConfirm(analysisAction("create_invoice"))?.message,
      "A draft invoice — it gets no number and posts nothing to the ledger until you issue it.",
    );
    assert.equal(
      analysisActionConfirm(analysisAction("create_estimate"))?.message,
      "A draft estimate — nothing is sent to the customer until you send it.",
    );
  });

  test("lets reversible and reviewable buttons run without a prompt", () => {
    // A draft nobody sent and a triage action one click undoes are not worth
    // a dialog; asking about them teaches Members to click through dialogs.
    assert.equal(analysisActionConfirm(analysisAction("draft_reply", { bodyText: "Hi" })), null);
    assert.equal(
      analysisActionConfirm(analysisAction("thread_action", { action: "archive" })),
      null,
    );
  });

  test("shows the whole handover instruction, because that is what is being approved", () => {
    // The instruction was written by an employee reading untrusted email, and
    // it becomes the brief for a turn with that employee's full tools. A label
    // alone would have the Member approving a sentence they never read.
    const confirmation = analysisActionConfirm(
      analysisAction("hand_over", {
        employeeId: "employee-2",
        targetEmployeeName: "Morgan",
        mode: "reply",
        instruction: "Resend the last three invoices to billing@elsewhere.example.",
      }),
    );

    assert.ok(confirmation);
    assert.equal(confirmation.title, "Hand this thread to Morgan?");
    assert.match(confirmation.message, /replies for you/);
    assert.match(confirmation.message, /Resend the last three invoices/);
    assert.equal(confirmation.confirmLabel, "Hand over");
  });

  test("still asks about a handover that carries no instruction or employee name", () => {
    const confirmation = analysisActionConfirm(
      analysisAction("hand_over", { employeeId: "employee-2" }),
    );

    assert.ok(confirmation);
    assert.equal(confirmation.title, "Hand this thread to an AI employee?");
    assert.match(confirmation.message, /work the thread/);
    assert.match(confirmation.message, /\(no instruction\)/);
  });
});

describe("analysis employee eligibility", () => {
  test("is eligible only with both a mailbox grant and a connected model", () => {
    const options = analysisEmployeeOptions([
      rosterEntry({ id: "ready", accessLevel: "draft" }),
      rosterEntry({ id: "no-grant", accessLevel: null }),
      rosterEntry({ id: "no-model", models: [], hasModel: false }),
      rosterEntry({ id: "neither", accessLevel: null, models: [], hasModel: false }),
    ]);

    assert.deepEqual(
      options.map(({ entry, eligible }) => ({ id: entry.id, eligible })),
      [
        { id: "ready", eligible: true },
        { id: "no-grant", eligible: false },
        { id: "no-model", eligible: false },
        { id: "neither", eligible: false },
      ],
    );
  });

  test("names what an ineligible employee is missing, and both when both are", () => {
    const options = analysisEmployeeOptions([
      rosterEntry({ id: "no-grant", accessLevel: null }),
      rosterEntry({ id: "no-model", models: [], hasModel: false }),
      rosterEntry({ id: "neither", accessLevel: null, models: [], hasModel: false }),
    ]);

    assert.deepEqual(
      options.map(({ detail }) => detail),
      ["no mailbox access", "no connected model", "no mailbox access · no connected model"],
    );
  });

  test("reads back the grant and the model count for an eligible employee", () => {
    const options = analysisEmployeeOptions([
      rosterEntry({ id: "read", accessLevel: "read" }),
      rosterEntry({ id: "draft", accessLevel: "draft" }),
      rosterEntry({
        id: "send",
        accessLevel: "send",
        models: [assistantModel(), assistantModel({ id: "model-2", model: "gpt" })],
      }),
    ]);

    assert.deepEqual(
      options.map(({ detail }) => detail),
      ["Read access · 1 model", "Draft access · 1 model", "Send access · 2 models"],
    );
  });

  test("keeps the roster order and hands each entry back for the picker", () => {
    const roster = [
      rosterEntry({ id: "employee-1", name: "Jamie" }),
      rosterEntry({ id: "employee-2", name: "Morgan", accessLevel: null }),
    ];

    assert.deepEqual(
      analysisEmployeeOptions(roster).map(({ entry }) => entry),
      roster,
    );
    assert.deepEqual(analysisEmployeeOptions([]), []);
  });
});

describe("analysis readiness note", () => {
  test("says nothing is analysed while the mailbox has analysis switched off", () => {
    assert.deepEqual(
      analysisReadinessNote({
        enabled: false,
        resolved: { employeeName: "Jamie", modelLabel: "claude-sonnet", accessLevel: "draft" },
      }),
      {
        tone: "off",
        text: "New mail arrives without a summary, action buttons, or automatic steps.",
      },
    );
  });

  test("warns when nobody resolves to read the mailbox", () => {
    assert.deepEqual(analysisReadinessNote({ enabled: true, resolved: null }), {
      tone: "warn",
      text: "No AI employee with a connected model has access to this mailbox yet, so nothing is being analysed. Grant one under AI access below.",
    });
  });

  test("warns that a reader on read access cannot prepare a reply review", () => {
    const note = analysisReadinessNote({
      enabled: true,
      resolved: { employeeName: "Jamie", modelLabel: "claude-sonnet", accessLevel: "read" },
    });

    assert.equal(note.tone, "warn");
    assert.equal(
      note.text,
      "Jamie reads new mail on claude-sonnet. On Read access they can summarise and suggest next steps, but cannot prepare a reply for Needs you or carry out your instructions — raise them to Draft for that.",
    );
    assert.match(note.text, /Draft/);
  });

  test("names the employee and the model once the mailbox is ready", () => {
    const readyLevels: MailAccessLevel[] = ["draft", "send"];
    for (const accessLevel of readyLevels) {
      assert.deepEqual(
        analysisReadinessNote({
          enabled: true,
          resolved: { employeeName: "Jamie", modelLabel: "claude-sonnet", accessLevel },
        }),
        { tone: "ok", text: "Jamie reads new mail on claude-sonnet." },
      );
    }
  });
});

describe("analysis category vocabulary across the server and client", () => {
  test("the client can label every category the server is allowed to emit", () => {
    assert.deepEqual([...MAIL_ANALYSIS_CATEGORIES], [...SERVER_MAIL_ANALYSIS_CATEGORIES]);
  });
});

describe("buttons a restricted Member may not press", () => {
  const MONEY_KINDS = MAIL_ANALYSIS_FINANCE_KINDS as readonly MailAnalysisAction["kind"][];
  const OTHER_KINDS = ACTION_KINDS.filter((kind) => !MONEY_KINDS.includes(kind));

  test("lets full finance access press everything", () => {
    for (const kind of ACTION_KINDS) {
      assert.equal(analysisActionBlockedReason(analysisAction(kind), "full"), null, kind);
    }
  });

  test("blocks both money buttons for read-only finance access", () => {
    for (const kind of MONEY_KINDS) {
      assert.equal(
        analysisActionBlockedReason(analysisAction(kind), "read"),
        "You have read-only finance access",
        kind,
      );
    }
  });

  test("blocks both money buttons for a Member shut out of finance entirely", () => {
    for (const kind of MONEY_KINDS) {
      assert.equal(
        analysisActionBlockedReason(analysisAction(kind), "none"),
        "You don’t have access to this company’s finances",
        kind,
      );
    }
  });

  test("never blocks a button that writes nothing to the ledger", () => {
    // Replying, unsubscribing, triaging and handing over are all governed by
    // the mailbox, not by Finance. Blocking them on a finance level would take
    // the inbox away from someone who is only restricted from billing.
    for (const level of ["none", "read", "full"] as FinanceAccess[]) {
      for (const kind of OTHER_KINDS) {
        assert.equal(
          analysisActionBlockedReason(analysisAction(kind), level),
          null,
          `${kind}/${level}`,
        );
      }
    }
  });

  test("agrees with the level the server would resolve for the same Member", () => {
    // The button and the route have to reach the same verdict, or the UI is
    // either lying about what is possible or hiding something that is. Both
    // sides read the level `financeAccessFor` produces.
    assert.equal(
      analysisActionBlockedReason(
        analysisAction("create_invoice"),
        financeAccessFor("owner", "none"),
      ),
      null,
      "an owner is full regardless of the membership column",
    );
    assert.equal(
      analysisActionBlockedReason(
        analysisAction("create_invoice"),
        financeAccessFor("admin", "read"),
      ),
      null,
      "an admin is full regardless of the membership column",
    );
    assert.ok(
      analysisActionBlockedReason(
        analysisAction("create_invoice"),
        financeAccessFor("member", "read"),
      ),
      "a member dialled down to read-only is blocked",
    );
    assert.ok(
      analysisActionBlockedReason(
        analysisAction("create_invoice"),
        financeAccessFor("member", undefined),
      ),
      "a missing membership fails closed on both sides",
    );
    assert.equal(
      analysisActionBlockedReason(
        analysisAction("create_invoice"),
        financeAccessFor("member", "full"),
      ),
      null,
      "an ordinary member with full access may raise an invoice",
    );
  });
});

describe("the finance-gated kinds across the server and client", () => {
  test("the client greys out exactly the buttons the server will refuse", () => {
    // The server gates on its list; the client decides what to offer from
    // its own. A money button added to one and not the other renders live and
    // then fails on the click — the confusing turn this whole change removed.
    assert.deepEqual([...MAIL_ANALYSIS_FINANCE_KINDS], [...SERVER_MAIL_ANALYSIS_FINANCE_KINDS]);
  });

  test("every finance-gated kind is a kind the model can actually propose", () => {
    for (const kind of MAIL_ANALYSIS_FINANCE_KINDS) {
      assert.ok(
        ACTION_KINDS.includes(kind as MailAnalysisAction["kind"]),
        `${kind} is gated but is not in the action vocabulary`,
      );
    }
  });
});

// ───────────────────────────── the instructions box ─────────────────────────────

describe("the instructions box while someone edits it", () => {
  test("has nothing to save until the words change", () => {
    const untouched = analysisInstructionsEdit({
      draft: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.deepEqual(untouched, {
      dirty: false,
      problem: null,
      canSave: false,
      canRestore: false,
      countLabel: "2 instructions",
    });
  });

  test("does not light up Save for trailing spaces or a Windows line ending", () => {
    const edit = analysisInstructionsEdit({
      draft: `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS.replace("\n", "   \r\n")}\n\n`,
      saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(edit.dirty, false);
    assert.equal(edit.canSave, false);
  });

  test("lets a real change be saved, and counts the instructions as the server will", () => {
    const edit = analysisInstructionsEdit({
      draft: `${DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS}\n\n- Archive shipping notifications.`,
      saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(edit.dirty, true);
    assert.equal(edit.canSave, true);
    assert.equal(edit.countLabel, "3 instructions");
    assert.equal(
      analysisInstructionsEdit({ draft: "Star mail.", saved: "", usingDefault: false }).countLabel,
      "1 instruction",
    );
  });

  test("an emptied box can be saved and says what that means", () => {
    const edit = analysisInstructionsEdit({
      draft: "  \n",
      saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(edit.canSave, true);
    assert.equal(edit.countLabel, "No instructions — new mail gets a summary and suggestions only");
  });

  test("blocks Save with the reason when the text cannot be stored", () => {
    const tooMany = analysisInstructionsEdit({
      draft: Array.from({ length: 31 }, (_, index) => `Rule ${index}`).join("\n"),
      saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
      usingDefault: true,
    });
    assert.equal(tooMany.dirty, true);
    assert.equal(tooMany.problem, "Keep it to 30 instructions or fewer, one per line.");
    assert.equal(tooMany.canSave, false);
  });

  test("offers Restore default only once the mailbox has its own text", () => {
    assert.equal(
      analysisInstructionsEdit({ draft: "x", saved: "x", usingDefault: false }).canRestore,
      true,
    );
    assert.equal(
      analysisInstructionsEdit({ draft: "", saved: "", usingDefault: false }).canRestore,
      true,
      "an emptied box can go back to the default too",
    );
    assert.equal(
      analysisInstructionsEdit({
        draft: "edited",
        saved: DEFAULT_MAIL_ANALYSIS_INSTRUCTIONS,
        usingDefault: true,
      }).canRestore,
      false,
      "unsaved edits to the default are reverted with Cancel instead",
    );
  });
});

describe("the readiness note and the instructions", () => {
  test("tells a Read-access reader's mailbox that the instructions will not be carried out", () => {
    const note = analysisReadinessNote({
      enabled: true,
      resolved: { employeeName: "Jamie", modelLabel: "claude-sonnet", accessLevel: "read" },
      canManageAccess: false,
    });
    assert.equal(note.tone, "warn");
    assert.match(note.text, /carry out your instructions/);
    assert.match(note.text, /an owner or admin can raise them to Draft/);
  });

  test("says nothing automatic happens while analysis is off", () => {
    assert.match(
      analysisReadinessNote({ enabled: false, resolved: null }).text,
      /without a summary, action buttons, or automatic steps/,
    );
  });
});

// ───────────────────────────── what the instructions did ─────────────────────────────

function autoStep(
  action: MailAnalysisAutoAction["action"],
  status: MailAnalysisAutoAction["status"],
  overrides: Partial<MailAnalysisAutoAction> = {},
): MailAnalysisAutoAction {
  return {
    id: `auto-${action}`,
    action,
    instruction: "Star emails that need my response and look important.",
    reason: "Asks for a reply by Friday.",
    status,
    ...overrides,
  };
}

const AUTO_KINDS: MailAnalysisAutoAction["action"][] = [
  "star",
  "markRead",
  "archive",
  "applyLabel",
  "unsubscribe",
];
const AUTO_STATUSES: MailAnalysisAutoAction["status"][] = [
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
  "undone",
];

describe("what an automatic step says", () => {
  test("names what happened in the server's words, for every step and outcome", () => {
    const titles = Object.fromEntries(
      AUTO_KINDS.map((kind) => [
        kind,
        AUTO_STATUSES.map((status) =>
          automaticActionTitle(
            autoStep(kind, status, kind === "applyLabel" ? { labelName: "Finance" } : {}),
          ),
        ),
      ]),
    );
    assert.deepEqual(titles, {
      star: ["Starring…", "Starring…", "Starred", "Didn’t star", "Couldn’t star", "Starred — undone"],
      markRead: [
        "Marking read…",
        "Marking read…",
        "Marked read",
        "Didn’t mark read",
        "Couldn’t mark read",
        "Marked read — undone",
      ],
      archive: [
        "Archiving…",
        "Archiving…",
        "Archived",
        "Didn’t archive",
        "Couldn’t archive",
        "Archived — undone",
      ],
      applyLabel: [
        "Labelling “Finance”…",
        "Labelling “Finance”…",
        "Labelled “Finance”",
        "Didn’t label “Finance”",
        "Couldn’t label “Finance”",
        "Labelled “Finance” — undone",
      ],
      unsubscribe: [
        "Unsubscribing…",
        "Unsubscribing…",
        "Unsubscribed",
        "Didn’t unsubscribe",
        "Couldn’t unsubscribe",
        "Unsubscribed — undone",
      ],
    });
  });

  test("never echoes the model's words as the title", () => {
    const step = autoStep("star", "done", { reason: "I SENT $10,000 TO THE VENDOR" });
    assert.equal(automaticActionTitle(step), "Starred");
  });

  test("calls a step off the list what it is", () => {
    assert.equal(
      automaticActionTitle(autoStep("other", "skipped")),
      "Not something Genosyn does on its own",
    );
  });

  test("says where an unsubscribe went, and that it is final", () => {
    assert.equal(
      automaticActionNote(autoStep("unsubscribe", "done", { targetHost: "lists.shop.example" })),
      "Sent to lists.shop.example. An unsubscribe can’t be undone.",
    );
    assert.equal(
      automaticActionNote(autoStep("unsubscribe", "done")),
      "An unsubscribe can’t be undone.",
    );
  });

  test("shows the server's reason for a step that was skipped or failed", () => {
    assert.equal(
      automaticActionNote(autoStep("star", "skipped", { detail: "AI work is stood down: Audit" })),
      "AI work is stood down: Audit",
    );
    assert.equal(
      automaticActionNote(autoStep("archive", "failed", { detail: "Gmail said no." })),
      "Gmail said no.",
    );
    assert.equal(automaticActionNote(autoStep("archive", "failed")), null);
    for (const status of ["pending", "running", "done", "undone"] as const) {
      assert.equal(automaticActionNote(autoStep("star", status, { detail: "x" })), null, status);
    }
  });

  test("tones a step by its outcome", () => {
    assert.deepEqual(
      AUTO_STATUSES.map((status) => automaticActionTone(autoStep("star", status))),
      ["working", "working", "done", "muted", "failed", "muted"],
    );
  });

  test("offers Undo for exactly the steps the server will take back", () => {
    for (const action of [...AUTO_KINDS, "other" as const]) {
      for (const status of AUTO_STATUSES) {
        const step = autoStep(action, status);
        assert.equal(
          automaticActionUndoable(step),
          serverAutoActionUndoable(step),
          `${action}/${status}`,
        );
      }
    }
  });

  test("knows every step the server can take", () => {
    assert.deepEqual(
      [...AUTO_KINDS].sort(),
      [...SERVER_MAIL_ANALYSIS_AUTOMATIC_KINDS].sort(),
    );
  });
});
