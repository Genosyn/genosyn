import assert from "node:assert/strict";
import test from "node:test";

import { codingRuntimeAvailability, requireCodingRuntime } from "./codingAvailability.js";

test("coding runtime is unavailable when the install-level switch is off", () => {
  const availability = codingRuntimeAvailability({
    enabled: false,
    executionMode: "bubblewrap",
    allowUnsafeHostExecution: true,
  });

  assert.equal(availability.available, false);
  if (availability.available) assert.fail("expected coding runtime to be unavailable");
  assert.match(availability.reason, /disabled/i);
});

test("host mode is unavailable until the operator separately acknowledges it", () => {
  const unacknowledged = codingRuntimeAvailability({
    enabled: true,
    executionMode: "host",
    allowUnsafeHostExecution: false,
  });
  assert.equal(unacknowledged.available, false);
  if (unacknowledged.available) assert.fail("expected host mode to be unavailable");
  assert.match(unacknowledged.reason, /explicitly acknowledge/i);
  assert.throws(
    () =>
      requireCodingRuntime({
        enabled: true,
        executionMode: "host",
        allowUnsafeHostExecution: false,
      }),
    /explicitly acknowledge/i,
  );

  assert.deepEqual(
    codingRuntimeAvailability({
      enabled: true,
      executionMode: "host",
      allowUnsafeHostExecution: true,
    }),
    { available: true, reason: null },
  );
});

test("bubblewrap mode does not require the unsafe-host acknowledgement", () => {
  assert.deepEqual(
    codingRuntimeAvailability({
      enabled: true,
      executionMode: "bubblewrap",
      allowUnsafeHostExecution: false,
    }),
    { available: true, reason: null },
  );
});
