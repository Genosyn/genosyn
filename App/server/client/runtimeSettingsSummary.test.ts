import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RUNTIME_DEFAULTS } from "../../client/lib/runtimeSettingsSummary.js";
import { RUNTIME_SETTINGS_DEFAULTS } from "../services/runtimeSettings.js";

/**
 * Admin → Runtime collapses each section to "Defaults" or "3 customized". The
 * server does not send the defaults, so the page keeps a copy and counts
 * against it. A copy is only safe if something notices when it goes stale; this
 * is that something. If it fails, a default changed on one side — update
 * `RUNTIME_DEFAULTS` in `client/lib/runtimeSettingsSummary.ts` to match
 * `RUNTIME_SETTINGS_DEFAULTS`, or the page will call a section customized (or
 * not) when it is the other way round.
 */
describe("Admin → Runtime defaults", () => {
  test("the page's copy of the shipped defaults is the server's", () => {
    assert.deepEqual(RUNTIME_DEFAULTS, RUNTIME_SETTINGS_DEFAULTS);
  });
});
