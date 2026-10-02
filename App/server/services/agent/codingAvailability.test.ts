import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../config.js";

import {
  codingRuntimeAvailability,
  noteRetiredExecutionMode,
  requireCodingRuntime,
  type CodingExecutionMode,
} from "./codingAvailability.js";

test("the shipped OpenCode host default is available without sandbox setup", () => {
  assert.equal(config.agent.codingTools.executionMode, "host");
  assert.equal(config.agent.codingTools.allowUnsafeHostExecution, true);
  assert.deepEqual(codingRuntimeAvailability(), { available: true, reason: null });
});

test("coding runtime is unavailable when the install-level switch is off", () => {
  const availability = codingRuntimeAvailability({
    enabled: false,
    executionMode: "host",
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
  assert.match(unacknowledged.reason, /allowUnsafeHostExecution/);
  assert.throws(
    () =>
      requireCodingRuntime({
        enabled: true,
        executionMode: "host",
        allowUnsafeHostExecution: false,
      }),
    /allowUnsafeHostExecution/,
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

test("an execution mode this build does not have fails closed", () => {
  // Boot narrows a stale "bubblewrap" to disabled; any seam that still saw the
  // raw value must refuse rather than run on the host.
  const retired = "bubblewrap" as unknown as CodingExecutionMode;
  const availability = codingRuntimeAvailability({
    enabled: true,
    executionMode: retired,
    allowUnsafeHostExecution: true,
  });
  assert.equal(availability.available, false);
});

test("a retired mode that boot disabled says so instead of stating policy", () => {
  const settings = {
    enabled: true,
    executionMode: "disabled" as const,
    allowUnsafeHostExecution: true,
  };

  // An operator who chose disabled themselves gets the plain statement.
  const chosen = codingRuntimeAvailability(settings);
  assert.equal(chosen.available, false);
  if (chosen.available) assert.fail("expected disabled mode to be unavailable");
  assert.equal(chosen.reason, "Command execution is disabled on this Genosyn installation.");

  noteRetiredExecutionMode(
    'the operator configuration selects the unsupported "bubblewrap" execution mode. Set config.agent.codingTools.executionMode to "host" to run commands.',
  );
  try {
    const narrowed = codingRuntimeAvailability(settings);
    assert.equal(narrowed.available, false);
    if (narrowed.available) assert.fail("expected the narrowed mode to stay unavailable");
    assert.match(narrowed.reason, /^Command execution is disabled: /);
    assert.match(narrowed.reason, /"bubblewrap"/);
    assert.match(narrowed.reason, /executionMode to "host"/);
  } finally {
    noteRetiredExecutionMode(null);
  }
});
