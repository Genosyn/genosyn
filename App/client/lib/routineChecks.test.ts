import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RoutineCheck } from "./api";
import {
  buildCheckSpec,
  checkSpecDraft,
  describeCheck,
  readEffectSpec,
  type CheckSpecDraft,
} from "./routineChecks";

function check(over: Partial<RoutineCheck> = {}): RoutineCheck {
  return {
    id: "chk",
    routineId: "rt",
    name: "The digest reached Slack",
    kind: "effect",
    spec: JSON.stringify({ action: "mail.send", min: 1 }),
    required: true,
    enabled: true,
    timeoutSec: 120,
    position: 0,
    createdById: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function draft(over: Partial<CheckSpecDraft> = {}): CheckSpecDraft {
  return {
    kind: "effect",
    command: "",
    action: "mail.send",
    targetType: "",
    min: "1",
    max: "",
    ...over,
  };
}

describe("readEffectSpec", () => {
  test("reads a full spec", () => {
    const spec = readEffectSpec(
      '{"action":"mail.send","targetType":"mail_message","min":2,"max":5}',
    );
    assert.deepEqual(spec, {
      action: "mail.send",
      targetType: "mail_message",
      min: 2,
      max: 5,
    });
  });

  test("defaults a missing min to 1 and leaves max open", () => {
    assert.deepEqual(readEffectSpec('{"action":"deal.update"}'), {
      action: "deal.update",
      targetType: undefined,
      min: 1,
      max: undefined,
    });
  });

  test("refuses anything it cannot read rather than guessing", () => {
    // An assertion nobody can read is one that did not pass; a permissive
    // fallback here would describe a Check the server will never make.
    assert.equal(readEffectSpec("not json at all"), null);
    assert.equal(readEffectSpec("{}"), null);
    assert.equal(readEffectSpec('{"action":""}'), null);
    assert.equal(readEffectSpec('{"action":42}'), null);
    assert.equal(readEffectSpec("[1,2,3]"), null);
    assert.equal(readEffectSpec(""), null);
  });
});

describe("describeCheck", () => {
  test("describes an open-ended effect assertion", () => {
    assert.equal(describeCheck(check()), "The effect ledger must record at least 1 `mail.send`.");
  });

  test("names the target type and the window when both are set", () => {
    assert.equal(
      describeCheck(
        check({
          spec: JSON.stringify({ action: "mail.send", targetType: "mail_message", min: 1, max: 3 }),
        }),
      ),
      "The effect ledger must record between 1 and 3 `mail.send` on mail_message.",
    );
  });

  test("says a command must exit 0, with its timeout in readable units", () => {
    assert.equal(
      describeCheck(check({ kind: "command", spec: " npm test ", timeoutSec: 120 })),
      "The command `npm test` must exit 0, within 2m.",
    );
    assert.equal(
      describeCheck(check({ kind: "command", spec: "make verify", timeoutSec: 45 })),
      "The command `make verify` must exit 0, within 45s.",
    );
    assert.equal(
      describeCheck(check({ kind: "command", spec: "make verify", timeoutSec: 3600 })),
      "The command `make verify` must exit 0, within 1h.",
    );
  });

  test("an unreadable definition says so on the row", () => {
    assert.equal(
      describeCheck(check({ spec: "{oops" })),
      "Its definition cannot be read, so this check will not pass.",
    );
    assert.equal(
      describeCheck(check({ kind: "command", spec: "   " })),
      "No command is set, so this check will not pass.",
    );
  });
});

describe("buildCheckSpec", () => {
  test("an effect spec omits the optional fields that were left blank", () => {
    const built = buildCheckSpec(draft());
    assert.equal(built.ok, true);
    assert.equal(built.ok && built.spec, '{"action":"mail.send","min":1}');
  });

  test("carries the target type and ceiling when they are given", () => {
    const built = buildCheckSpec(
      draft({ targetType: " mail_message ", min: "2", max: "4", action: " mail.send " }),
    );
    assert.equal(built.ok, true);
    assert.equal(
      built.ok && built.spec,
      '{"action":"mail.send","targetType":"mail_message","min":2,"max":4}',
    );
  });

  test("a zero minimum survives, because 'this must not happen' is a real check", () => {
    const built = buildCheckSpec(draft({ min: "0", max: "0" }));
    assert.equal(built.ok, true);
    assert.equal(built.ok && built.spec, '{"action":"mail.send","min":0,"max":0}');
  });

  test("refuses a window no count could satisfy", () => {
    const built = buildCheckSpec(draft({ min: "3", max: "1" }));
    assert.equal(built.ok, false);
    assert.match(built.ok ? "" : built.error, /at least the minimum/);
  });

  test("refuses fractional and negative bounds", () => {
    assert.equal(buildCheckSpec(draft({ min: "1.5" })).ok, false);
    assert.equal(buildCheckSpec(draft({ min: "-1" })).ok, false);
    assert.equal(buildCheckSpec(draft({ max: "2.5" })).ok, false);
    assert.equal(buildCheckSpec(draft({ min: "" })).ok, false);
  });

  test("refuses an effect assertion with no action to count", () => {
    const built = buildCheckSpec(draft({ action: "   " }));
    assert.equal(built.ok, false);
    assert.match(built.ok ? "" : built.error, /needs an action/);
  });

  test("a command spec is the trimmed command itself", () => {
    const built = buildCheckSpec(draft({ kind: "command", command: "  npm test --silent  " }));
    assert.equal(built.ok, true);
    assert.equal(built.ok && built.spec, "npm test --silent");
  });

  test("refuses an empty command", () => {
    const built = buildCheckSpec(draft({ kind: "command", command: "   " }));
    assert.equal(built.ok, false);
    assert.match(built.ok ? "" : built.error, /needs a command/);
  });

  test("effect fields left over from a kind switch do not leak into a command spec", () => {
    // The editor keeps one draft across the toggle, so the fields the other
    // kind filled in are still populated. Only the active kind's may be read.
    const built = buildCheckSpec(
      draft({ kind: "command", command: "make verify", action: "mail.send", min: "9" }),
    );
    assert.equal(built.ok, true);
    assert.equal(built.ok && built.spec, "make verify");
  });
});

describe("checkSpecDraft", () => {
  test("a new check starts as an effect assertion — the kind every install can run", () => {
    assert.deepEqual(checkSpecDraft(null), {
      kind: "effect",
      command: "",
      action: "",
      targetType: "",
      min: "1",
      max: "",
    });
  });

  test("round-trips an existing effect check through the editor unchanged", () => {
    const original = check({
      spec: JSON.stringify({ action: "invoice.create", targetType: "invoice", min: 1, max: 2 }),
    });
    const rebuilt = buildCheckSpec(checkSpecDraft(original));
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(readEffectSpec(rebuilt.ok ? rebuilt.spec : ""), readEffectSpec(original.spec));
  });

  test("round-trips an existing command check", () => {
    const original = check({ kind: "command", spec: "npm run verify" });
    const rebuilt = buildCheckSpec(checkSpecDraft(original));
    assert.equal(rebuilt.ok && rebuilt.spec, "npm run verify");
  });

  test("an unreadable stored spec opens on empty fields rather than inventing one", () => {
    assert.deepEqual(checkSpecDraft(check({ spec: "{broken" })), {
      kind: "effect",
      command: "",
      action: "",
      targetType: "",
      min: "1",
      max: "",
    });
  });
});
