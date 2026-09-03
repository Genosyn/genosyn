import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  clampSignaturePage,
  duplicateSignatureFieldGeometry,
  signatureCompletionProgress,
  signatureDraftReadiness,
  signatureEditorShortcut,
  signatureFieldPageSummary,
  signatureFieldPagesToFill,
  signatureReadinessTarget,
  signatureRecipientEmailProblem,
  signatureScrollAncestorIndex,
  signatureShortcutTargetIsTextEntry,
  visibleSignaturePage,
  type SignatureDraftReadinessIssue,
  type SignatureField,
  type SignatureRecipient,
} from "./signing";

function field(over: Partial<SignatureField> = {}): SignatureField {
  return {
    id: "fld",
    recipientId: "rcp",
    type: "signature",
    label: "Signature",
    placeholder: "",
    required: true,
    pageNumber: 1,
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.08,
    sortOrder: 0,
    ...over,
  };
}

function recipient(over: Partial<SignatureRecipient> = {}): SignatureRecipient {
  return {
    id: "rcp",
    role: "signer",
    name: "Dana Whitfield",
    email: "dana@northwind-logistics.test",
    routingOrder: 0,
    status: "waiting",
    lastDeliveryStatus: "pending",
    lastDeliveryError: "",
    lastDeliveredAt: null,
    reminderCount: 0,
    ...over,
  };
}

describe("duplicateSignatureFieldGeometry", () => {
  test("offsets the copy down and right so it does not hide the original", () => {
    const copy = duplicateSignatureFieldGeometry(field({ x: 0.1, y: 0.2 }));
    assert.ok(copy.x > 0.1);
    assert.ok(copy.y > 0.2);
  });

  test("keeps the copy's size", () => {
    const copy = duplicateSignatureFieldGeometry(field({ width: 0.3, height: 0.08 }));
    assert.equal(copy.width, 0.3);
    assert.equal(copy.height, 0.08);
  });

  test("offsets back up and left at the bottom-right corner", () => {
    const copy = duplicateSignatureFieldGeometry(
      field({ x: 0.7, y: 0.92, width: 0.3, height: 0.08 }),
    );
    assert.ok(copy.x < 0.7, `x moved to ${copy.x}`);
    assert.ok(copy.y < 0.92, `y moved to ${copy.y}`);
  });

  test("keeps the copy inside the page", () => {
    const copy = duplicateSignatureFieldGeometry(
      field({ x: 0.68, y: 0.9, width: 0.3, height: 0.08 }),
    );
    assert.ok(copy.x >= 0 && copy.x + copy.width <= 1);
    assert.ok(copy.y >= 0 && copy.y + copy.height <= 1);
  });

  test("a field filling the page stays put rather than escaping it", () => {
    const copy = duplicateSignatureFieldGeometry({ x: 0, y: 0, width: 1, height: 1 });
    assert.ok(copy.x >= 0 && copy.x + copy.width <= 1);
    assert.ok(copy.y >= 0 && copy.y + copy.height <= 1);
  });

  test("honours a custom offset", () => {
    const copy = duplicateSignatureFieldGeometry(field({ x: 0.1, y: 0.1 }), 0.1);
    assert.ok(Math.abs(copy.x - 0.2) < 1e-9, `x=${copy.x}`);
    assert.ok(Math.abs(copy.y - 0.2) < 1e-9, `y=${copy.y}`);
  });

  test("treats a non-finite offset as the default", () => {
    const copy = duplicateSignatureFieldGeometry(field({ x: 0.1, y: 0.1 }), Number.NaN);
    assert.ok(copy.x > 0.1 && copy.x < 0.15);
  });
});

describe("signatureFieldPagesToFill", () => {
  const source = field({ recipientId: "dana", type: "signature", pageNumber: 1 });

  test("returns every page the signer does not already have", () => {
    assert.deepEqual(signatureFieldPagesToFill(source, [source], 4), [2, 3, 4]);
  });

  test("returns nothing when the signer already has one on each page", () => {
    const existing = [1, 2, 3].map((pageNumber) =>
      field({ recipientId: "dana", type: "signature", pageNumber }),
    );
    assert.deepEqual(signatureFieldPagesToFill(source, existing, 3), []);
  });

  test("ignores another signer's fields on the same page", () => {
    const other = field({ recipientId: "marcus", type: "signature", pageNumber: 2 });
    assert.deepEqual(signatureFieldPagesToFill(source, [source, other], 3), [2, 3]);
  });

  test("ignores the same signer's other field types", () => {
    const date = field({ recipientId: "dana", type: "date", pageNumber: 2 });
    assert.deepEqual(signatureFieldPagesToFill(source, [source, date], 3), [2, 3]);
  });

  test("a single-page document leaves nothing to fill", () => {
    assert.deepEqual(signatureFieldPagesToFill(source, [source], 1), []);
  });

  test("an unknown page count fills nothing rather than guessing", () => {
    assert.deepEqual(signatureFieldPagesToFill(source, [source], 0), []);
    assert.deepEqual(signatureFieldPagesToFill(source, [source], -3), []);
    assert.deepEqual(signatureFieldPagesToFill(source, [source], 2.5), []);
  });
});

describe("signatureFieldPageSummary", () => {
  test("counts the fields on every page, including the empty ones", () => {
    const fields = [
      field({ id: "a", pageNumber: 1 }),
      field({ id: "b", pageNumber: 3 }),
      field({ id: "c", pageNumber: 3 }),
    ];
    assert.deepEqual(signatureFieldPageSummary(fields, 3), [
      { pageNumber: 1, fieldCount: 1 },
      { pageNumber: 2, fieldCount: 0 },
      { pageNumber: 3, fieldCount: 2 },
    ]);
  });

  test("ignores fields pointing past the end of the document", () => {
    const fields = [field({ pageNumber: 9 })];
    assert.deepEqual(signatureFieldPageSummary(fields, 2), [
      { pageNumber: 1, fieldCount: 0 },
      { pageNumber: 2, fieldCount: 0 },
    ]);
  });

  test("an unknown page count summarizes nothing", () => {
    assert.deepEqual(signatureFieldPageSummary([field()], 0), []);
  });
});

describe("clampSignaturePage", () => {
  test("keeps a page inside the document", () => {
    assert.equal(clampSignaturePage(1, 5), 1);
    assert.equal(clampSignaturePage(5, 5), 5);
    assert.equal(clampSignaturePage(0, 5), 1);
    assert.equal(clampSignaturePage(9, 5), 5);
  });

  test("rounds a fractional page", () => {
    assert.equal(clampSignaturePage(2.4, 5), 2);
    assert.equal(clampSignaturePage(2.6, 5), 3);
  });

  test("falls back to the first page for junk input", () => {
    assert.equal(clampSignaturePage(Number.NaN, 5), 1);
    assert.equal(clampSignaturePage(3, 0), 1);
  });
});

describe("visibleSignaturePage", () => {
  const pages = [
    { pageNumber: 1, top: 0, bottom: 900 },
    { pageNumber: 2, top: 900, bottom: 1800 },
    { pageNumber: 3, top: 1800, bottom: 2700 },
  ];

  test("picks the page filling most of the viewport", () => {
    assert.equal(visibleSignaturePage(pages, { top: 850, bottom: 1750 }), 2);
  });

  test("a viewport wholly inside one page reports that page", () => {
    assert.equal(visibleSignaturePage(pages, { top: 1900, bottom: 2200 }), 3);
  });

  test("an exact tie prefers the earlier page, so scrolling never reads backwards", () => {
    assert.equal(visibleSignaturePage(pages, { top: 450, bottom: 1350 }), 1);
  });

  test("a viewport above the document reports the first page", () => {
    assert.equal(visibleSignaturePage(pages, { top: -500, bottom: -100 }), 1);
  });

  test("no pages reports the first page rather than throwing", () => {
    assert.equal(visibleSignaturePage([], { top: 0, bottom: 100 }), 1);
  });
});

describe("signatureScrollAncestorIndex", () => {
  test("skips a column that may scroll but does not", () => {
    const index = signatureScrollAncestorIndex([
      { overflowY: "auto", scrollHeight: 2857, clientHeight: 2857 },
      { overflowY: "visible", scrollHeight: 2857, clientHeight: 2857 },
      { overflowY: "auto", scrollHeight: 2981, clientHeight: 844 },
    ]);
    assert.equal(index, 2);
  });

  test("takes the nearest ancestor that really scrolls", () => {
    const index = signatureScrollAncestorIndex([
      { overflowY: "scroll", scrollHeight: 2000, clientHeight: 600 },
      { overflowY: "auto", scrollHeight: 4000, clientHeight: 600 },
    ]);
    assert.equal(index, 0);
  });

  test("ignores a non-scrolling overflow value", () => {
    const index = signatureScrollAncestorIndex([
      { overflowY: "hidden", scrollHeight: 4000, clientHeight: 600 },
    ]);
    assert.equal(index, -1);
  });

  test("reports none when nothing scrolls", () => {
    assert.equal(signatureScrollAncestorIndex([]), -1);
  });
});

describe("signatureReadinessTarget", () => {
  test("routes a title issue to the title field", () => {
    assert.deepEqual(signatureReadinessTarget({ code: "title", message: "" }), { kind: "title" });
  });

  test("routes an expiry issue to the expiry field", () => {
    assert.deepEqual(signatureReadinessTarget({ code: "expiry", message: "" }), { kind: "expiry" });
  });

  test("routes 'no signers' to the add-recipient control", () => {
    assert.deepEqual(signatureReadinessTarget({ code: "signer", message: "" }), {
      kind: "add-recipient",
    });
  });

  test("routes a recipient issue to the exact input it is about", () => {
    assert.deepEqual(
      signatureReadinessTarget({
        code: "recipient",
        message: "",
        recipientId: "r1",
        input: "name",
      }),
      { kind: "recipient", recipientId: "r1", input: "name" },
    );
  });

  test("routes a duplicate address to that recipient's email", () => {
    assert.deepEqual(
      signatureReadinessTarget({
        code: "duplicate_email",
        message: "",
        recipientId: "r2",
        input: "email",
      }),
      { kind: "recipient", recipientId: "r2", input: "email" },
    );
  });

  test("routes a missing signature to the document, for that signer", () => {
    assert.deepEqual(
      signatureReadinessTarget({ code: "signature", message: "", recipientId: "r1" }),
      { kind: "signature", recipientId: "r1" },
    );
  });

  test("falls back to the email input when an older issue names no input", () => {
    assert.deepEqual(
      signatureReadinessTarget({ code: "recipient", message: "", recipientId: "r1" }),
      { kind: "recipient", recipientId: "r1", input: "email" },
    );
  });

  test("a recipient issue with no recipient still leads somewhere useful", () => {
    assert.deepEqual(signatureReadinessTarget({ code: "recipient", message: "" }), {
      kind: "add-recipient",
    });
  });
});

describe("signatureDraftReadiness", () => {
  const envelope = { title: "Mutual NDA", expiresAt: null };

  test("names the input behind a missing name", () => {
    const issues = signatureDraftReadiness(
      envelope,
      [recipient({ name: "  " })],
      [field({ recipientId: "rcp" })],
    );
    const issue = issues.find((candidate) => /needs a name/.test(candidate.message));
    assert.equal(issue?.input, "name");
    assert.equal(issue?.recipientId, "rcp");
  });

  test("names the input behind an invalid address", () => {
    const issues = signatureDraftReadiness(
      envelope,
      [recipient({ email: "not-an-address" })],
      [field({ recipientId: "rcp" })],
    );
    const issue = issues.find((candidate) => /valid email/.test(candidate.message));
    assert.equal(issue?.input, "email");
  });

  test("names the input behind a duplicate address", () => {
    const issues = signatureDraftReadiness(
      envelope,
      [
        recipient({ id: "a", name: "Dana", email: "dana@northwind-logistics.test" }),
        recipient({ id: "b", name: "Dana again", email: "DANA@northwind-logistics.test" }),
      ],
      [field({ recipientId: "a" }), field({ recipientId: "b" })],
    );
    const issue = issues.find((candidate) => candidate.code === "duplicate_email");
    assert.equal(issue?.input, "email");
    assert.equal(issue?.recipientId, "b");
  });

  test("a complete draft has nothing left to answer", () => {
    assert.deepEqual(
      signatureDraftReadiness(envelope, [recipient()], [field({ recipientId: "rcp" })]),
      [],
    );
  });
});

describe("signatureRecipientEmailProblem", () => {
  test("stays quiet on an untouched row", () => {
    const row = recipient({ email: "" });
    assert.equal(signatureRecipientEmailProblem(row, [row]), null);
  });

  test("stays quiet on whitespace alone", () => {
    const row = recipient({ email: "   " });
    assert.equal(signatureRecipientEmailProblem(row, [row]), null);
  });

  test("flags a malformed address", () => {
    const row = recipient({ email: "dana@@northwind" });
    assert.equal(
      signatureRecipientEmailProblem(row, [row]),
      "This does not look like an email address.",
    );
  });

  test("accepts a valid address", () => {
    const row = recipient();
    assert.equal(signatureRecipientEmailProblem(row, [row]), null);
  });

  test("flags an address an earlier recipient already used", () => {
    const first = recipient({ id: "a", name: "Dana Whitfield" });
    const second = recipient({ id: "b", name: "Dana again" });
    assert.equal(
      signatureRecipientEmailProblem(second, [first, second]),
      "Already used by Dana Whitfield.",
    );
  });

  test("blames the later row, never the first one", () => {
    const first = recipient({ id: "a" });
    const second = recipient({ id: "b" });
    assert.equal(signatureRecipientEmailProblem(first, [first, second]), null);
  });

  test("matches addresses that differ only by case or padding", () => {
    const first = recipient({ id: "a", name: "Dana Whitfield" });
    const second = recipient({ id: "b", email: "  DANA@Northwind-Logistics.test " });
    assert.equal(
      signatureRecipientEmailProblem(second, [first, second]),
      "Already used by Dana Whitfield.",
    );
  });

  test("names an unnamed duplicate without printing an empty name", () => {
    const first = recipient({ id: "a", name: "   " });
    const second = recipient({ id: "b" });
    assert.equal(
      signatureRecipientEmailProblem(second, [first, second]),
      "Already used by another recipient.",
    );
  });
});

describe("signatureEditorShortcut", () => {
  test("recognises duplicate on both platforms", () => {
    assert.equal(signatureEditorShortcut({ key: "d", metaKey: true }), "duplicate");
    assert.equal(signatureEditorShortcut({ key: "d", ctrlKey: true }), "duplicate");
    assert.equal(signatureEditorShortcut({ key: "D", metaKey: true }), "duplicate");
  });

  test("recognises delete from either key", () => {
    assert.equal(signatureEditorShortcut({ key: "Delete" }), "delete");
    assert.equal(signatureEditorShortcut({ key: "Backspace" }), "delete");
  });

  test("leaves a bare letter alone so typing is never swallowed", () => {
    assert.equal(signatureEditorShortcut({ key: "d" }), null);
  });

  test("leaves the browser's own modifier shortcuts alone", () => {
    assert.equal(signatureEditorShortcut({ key: "Backspace", metaKey: true }), null);
    assert.equal(signatureEditorShortcut({ key: "r", metaKey: true }), null);
  });
});

describe("signatureShortcutTargetIsTextEntry", () => {
  test("recognises the controls where Backspace means a character", () => {
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "INPUT" }), true);
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "TEXTAREA" }), true);
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "SELECT" }), true);
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "input" }), true);
    assert.equal(
      signatureShortcutTargetIsTextEntry({ tagName: "DIV", isContentEditable: true }),
      true,
    );
  });

  test("lets the shortcut through elsewhere", () => {
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "DIV" }), false);
    assert.equal(signatureShortcutTargetIsTextEntry({ tagName: "BUTTON" }), false);
    assert.equal(signatureShortcutTargetIsTextEntry(null), false);
    assert.equal(signatureShortcutTargetIsTextEntry(undefined), false);
    assert.equal(signatureShortcutTargetIsTextEntry({}), false);
  });
});

describe("signatureCompletionProgress", () => {
  test("counts only the required fields", () => {
    const fields = [
      field({ id: "a", required: true }),
      field({ id: "b", required: false }),
      field({ id: "c", required: true }),
    ];
    assert.deepEqual(signatureCompletionProgress(fields, { a: "signed" }), {
      done: 1,
      total: 2,
      percent: 50,
    });
  });

  test("an untouched request reads as zero", () => {
    assert.deepEqual(signatureCompletionProgress([field({ id: "a" })], {}), {
      done: 0,
      total: 1,
      percent: 0,
    });
  });

  test("a finished request reads as complete", () => {
    assert.deepEqual(signatureCompletionProgress([field({ id: "a" })], { a: "Dana" }), {
      done: 1,
      total: 1,
      percent: 100,
    });
  });

  test("nothing required reads as complete, not as an empty bar", () => {
    assert.deepEqual(signatureCompletionProgress([field({ required: false })], {}), {
      done: 0,
      total: 0,
      percent: 100,
    });
  });

  test("a checkbox counts only when it is ticked", () => {
    const checkbox = field({ id: "a", type: "checkbox" });
    assert.equal(signatureCompletionProgress([checkbox], { a: false }).done, 0);
    assert.equal(signatureCompletionProgress([checkbox], { a: true }).done, 1);
  });

  test("whitespace alone does not complete a field", () => {
    assert.equal(signatureCompletionProgress([field({ id: "a" })], { a: "   " }).done, 0);
  });

  test("rounds the percentage for display", () => {
    const fields = [1, 2, 3].map((n) => field({ id: `f${n}` }));
    assert.equal(signatureCompletionProgress(fields, { f1: "x" }).percent, 33);
  });
});

describe("readiness issues are addressable end to end", () => {
  test("every issue a broken draft raises leads to a control", () => {
    const issues: SignatureDraftReadinessIssue[] = signatureDraftReadiness(
      { title: "", expiresAt: "2000-01-01T00:00:00.000Z" },
      [
        recipient({ id: "a", name: "", email: "nope" }),
        recipient({ id: "b", name: "Marcus", email: "marcus@acmefixture.test" }),
      ],
      [],
    );
    assert.ok(issues.length >= 5, `expected several issues, got ${issues.length}`);
    for (const issue of issues) {
      const target = signatureReadinessTarget(issue);
      assert.ok(
        ["title", "expiry", "add-recipient", "recipient", "signature"].includes(target.kind),
        `unroutable issue: ${JSON.stringify(issue)}`,
      );
    }
  });
});
