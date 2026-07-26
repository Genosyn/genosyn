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
import { listProviderIds } from "../integrations/index.js";

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
