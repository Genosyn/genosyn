import assert from "node:assert/strict";
import test from "node:test";

import {
  codingRuntimeAvailability,
  codingSandboxRemediation,
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
    assert.match(fallen.reason, /apt-get install bubblewrap/);
  } finally {
    noteCodingSandboxFallback(null);
  }
});

test("the stock-container cause names the options that fix it", () => {
  // The reason a Member actually reads on the Repository page. Docker's
  // default profile is the most common cause and the least guessable one, so
  // the message carries the exact options rather than a policy statement.
  const denied =
    "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.";
  noteCodingSandboxFallback(denied);
  try {
    const fallen = codingRuntimeAvailability({
      enabled: true,
      executionMode: "disabled",
      allowUnsafeHostExecution: false,
    });
    assert.equal(fallen.available, false);
    if (fallen.available) assert.fail("expected the fallback to stay unavailable");
    assert.match(fallen.reason, /seccomp=unconfined/);
    assert.match(fallen.reason, /systempaths=unconfined/);
    assert.match(fallen.reason, /genosyn upgrade/);
  } finally {
    noteCodingSandboxFallback(null);
  }

  // A missing executable is a different problem with a different fix, so it
  // does not get the container advice.
  const missing = codingSandboxRemediation("no bubblewrap executable at /usr/bin/bwrap");
  assert.match(missing, /apt-get install bubblewrap/);
  assert.doesNotMatch(missing, /seccomp/);
});
