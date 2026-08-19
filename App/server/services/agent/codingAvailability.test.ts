import assert from "node:assert/strict";
import test from "node:test";

import {
  codingRuntimeAvailability,
  noteCodingSandboxFallback,
  requireCodingRuntime,
} from "./codingAvailability.js";

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

test("a host that could not start the sandbox says so instead of stating policy", () => {
  const settings = {
    enabled: true,
    executionMode: "disabled" as const,
    allowUnsafeHostExecution: false,
  };

  // An operator who chose disabled themselves gets the plain statement.
  const chosen = codingRuntimeAvailability(settings);
  assert.equal(chosen.available, false);
  if (chosen.available) assert.fail("expected disabled mode to be unavailable");
  assert.equal(chosen.reason, "Command execution is disabled on this Genosyn installation.");

  noteCodingSandboxFallback("no bubblewrap executable at /usr/bin/bwrap");
  try {
    const fallen = codingRuntimeAvailability(settings);
    assert.equal(fallen.available, false);
    if (fallen.available) assert.fail("expected the fallback to stay unavailable");
    assert.match(fallen.reason, /no bubblewrap executable at \/usr\/bin\/bwrap/);
    assert.match(fallen.reason, /unprivileged user namespaces/);
  } finally {
    noteCodingSandboxFallback(null);
  }
});
