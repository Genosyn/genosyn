import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatContractSize,
  formatSignedDate,
} from "../../client/lib/contracts.js";
import {
  dataTransferHasFiles,
  filesFromDataTransfer,
  pastedUploadFiles,
} from "../../client/lib/fileDrop.js";
import {
  PRODUCT_INTEGRATION_KEYS,
  PRODUCT_INTEGRATION_SCOPES,
  productIntegrationScope,
} from "../../client/lib/productIntegrations.js";
import {
  clampIntervalCount,
  cronToParts,
  defaultScheduleParts,
  describeCron,
  describeParts,
  ordinal,
  partsToCron,
  timeInputValue,
  withTime,
  type ScheduleParts,
} from "../../client/lib/schedule.js";
import {
  ACCOUNT_SECTION,
  ADMIN_SECTION,
  HELP_SECTION,
  SECTION_BY_KEY,
  SECTION_GROUPS,
  activeSection,
  searchSections,
  type SectionItem,
  type SectionKey,
} from "../../client/lib/sections.js";
import { cronHuman, cronIsReadable, CRON_PRESETS, DEFAULT_CRON } from "../../client/lib/cron.js";
import {
  canRetryPublicSignatureFinalization,
  clampFieldGeometry,
  firstIncompleteRequiredSignatureField,
  lockSignatureSendReviewForDispatch,
  publicSignatureRecipientIsComplete,
  normalizeSignatureEmail,
  reconcileSignatureDraftSave,
  resizeSignatureFieldGeometry,
  signatureAiHandoffPrompt,
  signatureCalendarDateForOffset,
  signatureDateInputToEndOfDayIso,
  signatureFieldValueIsComplete,
  signatureFieldResizeHandlePosition,
  signatureIsoToDateInput,
  signatureDraftReadiness,
  signatureRecipientColor,
  signatureRecipientColorKey,
  signatureSendReviewIsCurrent,
  type SignatureEnvelope,
  type SignatureEnvelopeDetail,
  type SignatureField,
  type SignatureRecipient,
  type PublicSigningEnvelope,
} from "../../client/lib/signing.js";
import { listProviderIds } from "../integrations/index.js";

describe("signing date helpers", () => {
  test("assigns each signer a distinct identity-stable field color", () => {
    const recipientIds = Array.from({ length: 200 }, (_, index) => `recipient-${index}`);
    const colors = recipientIds.map((id) => signatureRecipientColor(id).dotColor);
    assert.equal(new Set(colors).size, recipientIds.length);
    assert.notEqual(
      signatureRecipientColor("alice").dotColor,
      signatureRecipientColor("bob").dotColor,
    );
    assert.equal(
      signatureRecipientColorKey({ id: "temporary", email: " ADA@Example.COM " }),
      signatureRecipientColorKey({ id: "persisted", email: "ada@example.com" }),
    );
    assert.equal(signatureRecipientColorKey({ id: "temporary", email: "" }), "temporary");

    const beforeReorder = new Map(
      recipientIds.map((id) => [id, signatureRecipientColor(id).dotColor]),
    );
    for (const id of [...recipientIds].reverse()) {
      assert.equal(signatureRecipientColor(id).dotColor, beforeReorder.get(id));
    }
  });

  test("keeps direct field resizing normalized, bounded, and anchored", () => {
    const closeTo = (actual: number, expected: number) =>
      assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not close to ${expected}`);
    const original = { x: 0.2, y: 0.2, width: 0.3, height: 0.1 };
    const resizedSouthEast = resizeSignatureFieldGeometry(original, "south-east", {
      x: 0.8,
      y: 0.5,
    });
    assert.equal(resizedSouthEast.x, original.x);
    assert.equal(resizedSouthEast.y, original.y);
    closeTo(resizedSouthEast.width, 0.6);
    closeTo(resizedSouthEast.height, 0.3);

    const resizedNorthWest = resizeSignatureFieldGeometry(original, "north-west", {
      x: -1,
      y: -1,
    });
    assert.equal(resizedNorthWest.x, 0);
    assert.equal(resizedNorthWest.y, 0);
    closeTo(resizedNorthWest.x + resizedNorthWest.width, original.x + original.width);
    closeTo(resizedNorthWest.y + resizedNorthWest.height, original.y + original.height);

    const minimum = resizeSignatureFieldGeometry(original, "south-east", {
      x: original.x,
      y: original.y,
    });
    closeTo(minimum.width, 0.04);
    closeTo(minimum.height, 0.025);

    const sanitized = clampFieldGeometry({
      x: -10,
      y: 10,
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
    });
    assert.equal(sanitized.x, 0);
    closeTo(sanitized.y, 0.93);
    assert.equal(sanitized.width, 0.28);
    assert.equal(sanitized.height, 0.07);

    const checkbox = { x: 0.955, y: 0.965, width: 0.045, height: 0.035 };
    const handle = signatureFieldResizeHandlePosition(checkbox, { width: 320, height: 414 });
    closeTo(handle.left + 44, checkbox.x * 320);
    assert.ok(handle.top >= 0 && handle.top + 44 <= 414);

    const middleHandle = signatureFieldResizeHandlePosition(
      { ...checkbox, x: 0.45, y: 0.45 },
      { width: 320, height: 414 },
    );
    closeTo(middleHandle.left, (0.45 + checkbox.width) * 320);
  });

  test("keeps the Ask AI handoff inside the signing tools' real capabilities", () => {
    const draft = signatureAiHandoffPrompt({
      id: "envelope-1",
      title: "Mutual NDA",
      status: "draft",
    });
    assert.match(draft, /saved setup/);
    assert.match(draft, /cannot read the source PDF contents or edit this existing draft/);
    assert.match(draft, /Do not send, remind, or void/);
    assert.doesNotMatch(draft, /review the PDF/i);

    const sent = signatureAiHandoffPrompt({
      id: "envelope-2",
      title: "Services agreement",
      status: "sent",
    });
    assert.match(sent, /recipient progress, routing, delivery state, and the evidence trail/);
    assert.match(sent, /never claim to have seen private signing links or signature values/);
    assert.match(sent, /Do not send a reminder or void/);
  });

  test("offers completion recovery only to the completed signer of an all-signed saga", () => {
    const receipt = {
      envelope: { status: "in_progress", finalizationPending: true },
      recipient: { status: "completed" },
    } as PublicSigningEnvelope;
    assert.equal(canRetryPublicSignatureFinalization(receipt), true);
    assert.equal(
      canRetryPublicSignatureFinalization({
        ...receipt,
        envelope: { ...receipt.envelope, finalizationPending: false },
      }),
      false,
    );
    assert.equal(
      canRetryPublicSignatureFinalization({
        ...receipt,
        recipient: { ...receipt.recipient, status: "viewed" },
      }),
      false,
    );
    assert.equal(
      canRetryPublicSignatureFinalization({
        ...receipt,
        envelope: { ...receipt.envelope, status: "completed" },
      }),
      false,
    );
  });

  test("recognizes a durably completed recipient even while finalization is pending", () => {
    const receipt = {
      envelope: { status: "in_progress", finalizationPending: true },
      recipient: { status: "completed" },
    } as PublicSigningEnvelope;
    assert.equal(publicSignatureRecipientIsComplete(receipt), true);
    assert.equal(
      publicSignatureRecipientIsComplete({
        ...receipt,
        recipient: { ...receipt.recipient, status: "viewed" },
      }),
      false,
    );
  });

  test("finds the first incomplete required signing field in document order", () => {
    const fields = [
      { id: "optional", type: "text", required: false },
      { id: "name", type: "text", required: true },
      { id: "accept", type: "checkbox", required: true },
      { id: "signature", type: "signature", required: true },
    ] as SignatureField[];
    const values = { name: " Ada ", accept: false, signature: "" };

    assert.equal(signatureFieldValueIsComplete(fields[1], values.name), true);
    assert.equal(signatureFieldValueIsComplete(fields[2], values.accept), false);
    assert.equal(firstIncompleteRequiredSignatureField(fields, values)?.id, "accept");
    assert.equal(
      firstIncompleteRequiredSignatureField(fields, {
        ...values,
        accept: true,
        signature: "Ada Lovelace",
      }),
      undefined,
    );
  });

  test("derives the signer's calendar date from the reported timezone offset", () => {
    const instant = new Date("2026-08-13T00:30:00.000Z");
    assert.equal(signatureCalendarDateForOffset(instant, 420), "2026-08-12");
    assert.equal(signatureCalendarDateForOffset(instant, -330), "2026-08-13");
    assert.equal(signatureCalendarDateForOffset(new Date("invalid"), 0), "");
    assert.equal(signatureCalendarDateForOffset(instant, 1.5), "");
  });

  test("round-trips expiry dates at local end-of-day", () => {
    const iso = signatureDateInputToEndOfDayIso("2026-08-31");
    assert.ok(iso);
    assert.equal(signatureIsoToDateInput(iso), "2026-08-31");
    assert.equal(signatureDateInputToEndOfDayIso("2026-02-30"), null);
  });

  test("explains every missing step before a draft can be sent", () => {
    const envelope = { title: "Agreement", expiresAt: null } as SignatureEnvelope;
    const signer = {
      id: "signer-1",
      role: "signer",
      name: "Ada Lovelace",
      email: "ada@example.com",
    } as SignatureRecipient;
    assert.deepEqual(
      signatureDraftReadiness(envelope, [signer], []).map((issue) => issue.message),
      ["Ada Lovelace needs a required signature field"],
    );
    const field = {
      id: "field-1",
      recipientId: signer.id,
      type: "signature",
      required: true,
    } as SignatureField;
    assert.deepEqual(signatureDraftReadiness(envelope, [signer], [field]), []);
  });

  test("flags incomplete and duplicate recipients without blocking draft persistence", () => {
    const envelope = { title: "", expiresAt: "2020-01-01T00:00:00.000Z" } as SignatureEnvelope;
    const first = {
      id: "first",
      role: "signer",
      name: "",
      email: "same@example.com",
    } as SignatureRecipient;
    const second = {
      id: "second",
      role: "copy",
      name: "Finance",
      email: "same@example.com",
    } as SignatureRecipient;
    const codes = signatureDraftReadiness(
      envelope,
      [first, second],
      [],
      new Date("2026-01-01"),
    ).map((issue) => issue.code);
    assert.deepEqual(codes, ["title", "recipient", "duplicate_email", "signature", "expiry"]);
  });

  test("matches the service's sender email rules", () => {
    assert.equal(normalizeSignatureEmail(" ADA+Legal@Example.COM "), "ada+legal@example.com");
    for (const invalid of ["a@b.c", "foo@bar", "foo@-example.com", ".foo@example.com"]) {
      assert.equal(normalizeSignatureEmail(invalid), null);
    }
  });

  test("keeps newer local edits when an older autosave finishes and blocks stale actions", () => {
    const original = {
      envelope: {
        id: "envelope-1",
        title: "Original title",
        message: "",
        customerId: null,
        routingMode: "parallel",
        expiresAt: null,
        updatedAt: "2026-08-12T10:00:00.000Z",
      },
      recipients: [],
      fields: [],
      events: [],
      customer: null,
    } as unknown as SignatureEnvelopeDetail;
    const locallyEdited = {
      ...original,
      envelope: {
        ...original.envelope,
        title: "Newest local title",
        message: "Added while saving",
      },
    };
    const saved = {
      ...original,
      envelope: {
        ...original.envelope,
        updatedAt: "2026-08-12T10:00:02.000Z",
      },
    };

    const result = reconcileSignatureDraftSave(locallyEdited, saved, 3, 4);
    assert.equal(result.current, false);
    assert.equal(result.detail.envelope.title, "Newest local title");
    assert.equal(result.detail.envelope.message, "Added while saving");
    assert.equal(result.detail.envelope.updatedAt, "2026-08-12T10:00:02.000Z");

    const currentResult = reconcileSignatureDraftSave(locallyEdited, saved, 4, 4);
    assert.equal(currentResult.current, true);
    assert.equal(currentResult.detail.envelope.title, "Original title");
  });

  test("requires send confirmation again whenever the reviewed draft changes", () => {
    const reviewed = { editRevision: 4, updatedAt: "2026-08-12T10:00:02.000Z" };
    const current = {
      editRevision: 4,
      updatedAt: "2026-08-12T10:00:02.000Z",
      dirty: false,
      saveInFlight: false,
    };
    assert.equal(signatureSendReviewIsCurrent(reviewed, current), true);
    assert.equal(signatureSendReviewIsCurrent(reviewed, { ...current, editRevision: 5 }), false);
    assert.equal(signatureSendReviewIsCurrent(reviewed, { ...current, dirty: true }), false);
    assert.equal(signatureSendReviewIsCurrent(reviewed, { ...current, saveInFlight: true }), false);
    assert.equal(
      signatureSendReviewIsCurrent(reviewed, {
        ...current,
        updatedAt: "2026-08-12T10:00:03.000Z",
      }),
      false,
    );

    let frozen = false;
    assert.equal(
      lockSignatureSendReviewForDispatch(reviewed, current, () => {
        frozen = true;
      }),
      true,
    );
    assert.equal(frozen, true);

    frozen = false;
    assert.equal(
      lockSignatureSendReviewForDispatch(reviewed, { ...current, editRevision: 5 }, () => {
        frozen = true;
      }),
      false,
    );
    assert.equal(frozen, false);
  });
});

describe("contract display helpers", () => {
  test("formats size boundaries and clamps invalid values", () => {
    assert.equal(formatContractSize(0), "0 B");
    assert.equal(formatContractSize(-1), "0 B");
    assert.equal(formatContractSize(Number.NaN), "0 B");
    assert.equal(formatContractSize(999), "999 B");
    assert.equal(formatContractSize(1_024), "1.0 KB");
    assert.equal(formatContractSize(10 * 1_024), "10 KB");
    assert.equal(formatContractSize(2.45 * 1_024 * 1_024), "2.5 MB");
    assert.equal(formatContractSize(5 * 1_024 ** 4), "5120 GB");
  });

  test("formats valid signed dates and rejects invalid or absent values", () => {
    assert.equal(formatSignedDate("2026-07-25T23:30:00-07:00"), "2026-07-26");
    assert.equal(formatSignedDate("not-a-date"), "No signed date");
    assert.equal(formatSignedDate(null), "No signed date");
  });
});

describe("friendly recurring schedule model", () => {
  const base = defaultScheduleParts();

  test("starts on the documented monthly weekday-morning defaults", () => {
    assert.deepEqual(base, {
      frequency: "monthly",
      intervalCount: 1,
      dayOfMonth: 1,
      weekday: 1,
      month: 1,
      hour: 9,
      minute: 0,
    });
  });

  test("clamps interval counts to whole values from 1 through 99", () => {
    assert.equal(clampIntervalCount(-10), 1);
    assert.equal(clampIntervalCount(2.6), 3);
    assert.equal(clampIntervalCount(1_000), 99);
    assert.equal(clampIntervalCount(Number.NaN), 1);
  });

  test("renders English ordinals around the irregular teens", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal),
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"],
    );
  });

  test("round-trips and clamps the time input", () => {
    assert.equal(timeInputValue({ ...base, hour: 7, minute: 5 }), "07:05");
    assert.equal(timeInputValue({ ...base, hour: 99, minute: -5 }), "23:00");
    assert.deepEqual(withTime(base, "14:37"), { ...base, hour: 14, minute: 37 });
    assert.deepEqual(withTime(base, "bad:value"), base);
    assert.deepEqual(withTime(base, "25:90"), { ...base, hour: 23, minute: 59 });
  });

  test("compiles every supported frequency to its canonical cron shape", () => {
    const p = { ...base, minute: 15, hour: 6, dayOfMonth: 12, weekday: 4, month: 9 };
    assert.equal(partsToCron({ ...p, frequency: "daily" }), "15 6 * * *");
    assert.equal(partsToCron({ ...p, frequency: "weekly" }), "15 6 * * 4");
    assert.equal(partsToCron({ ...p, frequency: "monthly" }), "15 6 12 * *");
    assert.equal(partsToCron({ ...p, frequency: "quarterly" }), "15 6 12 1,4,7,10 *");
    assert.equal(partsToCron({ ...p, frequency: "yearly" }), "15 6 12 9 *");
  });

  test("round-trips canonical cron shapes without inventing an interval", () => {
    const cases: ScheduleParts[] = [
      { ...base, frequency: "daily", hour: 3, minute: 5 },
      { ...base, frequency: "weekly", weekday: 6, hour: 7 },
      { ...base, frequency: "monthly", dayOfMonth: 31 },
      { ...base, frequency: "quarterly", dayOfMonth: 15 },
      { ...base, frequency: "yearly", month: 12, dayOfMonth: 25 },
    ];
    for (const input of cases) {
      const parsed = cronToParts(partsToCron(input));
      assert.equal(parsed.frequency, input.frequency);
      assert.equal(parsed.hour, input.hour);
      assert.equal(parsed.minute, input.minute);
      assert.equal(parsed.intervalCount, 1);
      if (input.frequency === "weekly") assert.equal(parsed.weekday, input.weekday);
      if (["monthly", "quarterly", "yearly"].includes(input.frequency)) {
        assert.equal(parsed.dayOfMonth, input.dayOfMonth);
      }
      if (input.frequency === "yearly") assert.equal(parsed.month, input.month);
    }
  });

  test("falls back safely on arbitrary cron while retaining simple time fields", () => {
    assert.deepEqual(cronToParts("bad"), base);
    assert.deepEqual(cronToParts("45 22 1-5 * *"), {
      ...base,
      hour: 22,
      minute: 45,
    });
    assert.equal(cronToParts("99 99 * * *").hour, 23);
    assert.equal(cronToParts("99 99 * * *").minute, 59);
  });

  test("describes singular and interval schedules without ambiguous plurals", () => {
    assert.equal(describeParts(base), "The 1st of every month at 9:00 AM");
    assert.equal(
      describeParts({ ...base, frequency: "weekly", weekday: 5, intervalCount: 2 }),
      "Every 2 weeks on Friday at 9:00 AM",
    );
    assert.equal(
      describeParts({
        ...base,
        frequency: "yearly",
        month: 7,
        dayOfMonth: 25,
        hour: 0,
        intervalCount: 3,
      }),
      "Every 3 years on July 25th at 12:00 AM",
    );
    assert.equal(describeCron("0 8 * * *", 4), "Every 4 days at 8:00 AM");
  });
});

describe("Routine cron helpers", () => {
  test("renders readable five- and six-field expressions", () => {
    assert.equal(cronIsReadable("0 9 * * 1-5"), true);
    assert.match(cronHuman("0 9 * * 1-5"), /09:00 AM|9:00 AM/);
    assert.equal(cronIsReadable("0 0 9 * * 1"), true);
  });

  test("returns the original expression when it cannot be rendered", () => {
    assert.equal(cronIsReadable("not cron"), false);
    assert.equal(cronHuman("not cron"), "not cron");
  });

  test("ships only readable, unique presets and uses one as the default", () => {
    assert.equal(new Set(CRON_PRESETS.map((preset) => preset.expr)).size, CRON_PRESETS.length);
    assert.ok(CRON_PRESETS.some((preset) => preset.expr === DEFAULT_CRON));
    assert.ok(CRON_PRESETS.every((preset) => cronIsReadable(preset.expr)));
  });
});

describe("product-scoped Integration catalogue", () => {
  test("has a complete key/index mapping and no unknown Integration ids", () => {
    assert.deepEqual(new Set(PRODUCT_INTEGRATION_KEYS), new Set(Object.keys(PRODUCT_INTEGRATION_SCOPES)));
    const providers = new Set(listProviderIds());
    for (const [key, scope] of Object.entries(PRODUCT_INTEGRATION_SCOPES)) {
      assert.ok(scope.label.trim(), `${key} lacks a label`);
      assert.ok(scope.description.trim(), `${key} lacks a description`);
      assert.equal(
        new Set(scope.providers ?? []).size,
        scope.providers?.length ?? 0,
        `${key} repeats an Integration`,
      );
      for (const provider of scope.providers ?? []) {
        assert.ok(providers.has(provider), `${key} references unknown Integration ${provider}`);
      }
    }
  });

  test("resolves only product sections and preserves deliberate all-catalog scopes", () => {
    assert.equal(productIntegrationScope("mail")?.providers?.[0], "google");
    assert.equal(productIntegrationScope("employees")?.providers, null);
    assert.equal(productIntegrationScope("home"), null);
    assert.equal(productIntegrationScope("settings"), null);
  });
});

describe("section routing and command search", () => {
  const items = [
    ...SECTION_GROUPS.flatMap((group) => group.items),
    HELP_SECTION,
    ACCOUNT_SECTION,
    ADMIN_SECTION,
  ];

  test("indexes every section exactly once", () => {
    assert.equal(new Set(items.map((item) => item.key)).size, items.length);
    assert.equal(Object.keys(SECTION_BY_KEY).length, items.length);
    for (const item of items) assert.equal(SECTION_BY_KEY[item.key], item);
  });

  test("maps company routes to their owning section without substring collisions", () => {
    const keys = [
      "inbox",
      "mail",
      "workspace",
      "employees",
      "skills",
      "routines",
      "tasks",
      "bases",
      "notes",
      "resources",
      "explore",
      "code",
      "marketing",
      "revenue",
      "customers",
      "finance",
      "pipelines",
      "approvals",
      "help",
      "account",
      "admin",
      "settings",
    ] as SectionKey[];
    for (const key of keys) {
      assert.equal(activeSection(`/c/acme/${key}`), key);
      assert.equal(activeSection(`/c/acme/${key}/nested`), key);
    }
    assert.equal(activeSection("/c/acme/not-email"), "home");
    assert.equal(activeSection("/admin"), "home");
  });

  test("ranks exact, prefix, boundary, keyword, description, and fuzzy matches", () => {
    const custom: SectionItem[] = [
      {
        ...SECTION_BY_KEY.notes,
        label: "Notes",
        description: "Write reference pages",
        keywords: ["wiki"],
      },
      {
        ...SECTION_BY_KEY.employees,
        label: "AI Employees",
        description: "Autonomous colleagues",
        keywords: ["workers"],
      },
      {
        ...SECTION_BY_KEY.mail,
        label: "Gmail Archive",
        description: "Correspondence",
        keywords: [],
      },
    ];
    assert.equal(searchSections(custom, "notes")[0].item.label, "Notes");
    assert.deepEqual(searchSections(custom, "not")[0].hit, [0, 3]);
    assert.deepEqual(searchSections(custom, "employees")[0].hit, [3, 12]);
    assert.equal(searchSections(custom, "wiki")[0].item.label, "Notes");
    assert.equal(searchSections(custom, "reference")[0].item.label, "Notes");
    assert.equal(searchSections(custom, "aiemp")[0].item.label, "AI Employees");
  });

  test("ANDs multi-token queries, keeps stable ties, and returns all on blank input", () => {
    const first = SECTION_BY_KEY.employees;
    const second = SECTION_BY_KEY.skills;
    const all = searchSections([first, second], "  ");
    assert.deepEqual(all.map((row) => row.item), [first, second]);
    assert.equal(searchSections(items, "ai employees")[0].item.key, "employees");
    assert.equal(searchSections(items, "employee finance").some((row) => row.item.key === "employees"), false);

    const ties = searchSections(
      [
        { ...first, label: "Alpha", keywords: ["shared"] },
        { ...second, label: "Beta", keywords: ["shared"] },
      ],
      "shared",
    );
    assert.deepEqual(ties.map((row) => row.item.label), ["Alpha", "Beta"]);
  });
});

describe("paste and drop file extraction", () => {
  const first = { name: "first.png" } as File;
  const second = { name: "second.pdf" } as File;

  function transfer(overrides: Partial<DataTransfer> = {}): DataTransfer {
    return {
      items: [] as unknown as DataTransferItemList,
      files: [] as unknown as FileList,
      types: [],
      getData: () => "",
      ...overrides,
    } as DataTransfer;
  }

  test("prefers file items and does not upload the same files list twice", () => {
    const dt = transfer({
      items: [
        { kind: "file", getAsFile: () => first },
        { kind: "string", getAsFile: () => null },
      ] as unknown as DataTransferItemList,
      files: [first, second] as unknown as FileList,
    });
    assert.deepEqual(filesFromDataTransfer(dt), [first]);
  });

  test("falls back to files when items contain no usable file", () => {
    const dt = transfer({
      items: [{ kind: "file", getAsFile: () => null }] as unknown as DataTransferItemList,
      files: [second] as unknown as FileList,
    });
    assert.deepEqual(filesFromDataTransfer(dt), [second]);
    assert.deepEqual(filesFromDataTransfer(null), []);
  });

  test("keeps text-bearing pastes as text and accepts image-only pastes", () => {
    const imageOnly = transfer({
      items: [{ kind: "file", getAsFile: () => first }] as unknown as DataTransferItemList,
    });
    assert.deepEqual(pastedUploadFiles(imageOnly), [first]);
    assert.deepEqual(
      pastedUploadFiles(transfer({ getData: () => "copied spreadsheet cells", files: [first] as unknown as FileList })),
      [],
    );
  });

  test("detects file drags before the browser exposes their files", () => {
    assert.equal(dataTransferHasFiles(transfer({ types: ["Files"] })), true);
    assert.equal(
      dataTransferHasFiles(transfer({ files: [first] as unknown as FileList })),
      true,
    );
    assert.equal(dataTransferHasFiles(transfer({ types: ["text/plain"] })), false);
    assert.equal(dataTransferHasFiles(undefined), false);
  });
});
