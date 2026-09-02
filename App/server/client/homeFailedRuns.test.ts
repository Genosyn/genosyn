import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const homeSource = fs.readFileSync(path.join(appRoot, "client/pages/Home.tsx"), "utf8");

/**
 * The Home "Failed routines" panel is the only place a member sees a broken
 * Run without opening the routine, so the retry lives there. These assertions
 * guard the two halves of that affordance that are easy to lose in a refactor:
 * it asks before it fires, and taking it retires the row it came from.
 */
describe("Home failed-routines retry", () => {
  test("every failed row offers the retry, not just interrupted ones", () => {
    const panel = homeSource.slice(homeSource.indexOf("data.failedRuns.map((r) =>"));
    assert.match(panel, /aria-label=\{`Retry \$\{r\.routineName\}`\}/);
    assert.ok(
      !/r\.status === "interrupted" && \(\s*<button/.test(homeSource),
      "the retry button is gated on a status again",
    );
  });

  test("retrying triggers the routine and dismisses the failed run", () => {
    const retry = homeSource.slice(
      homeSource.indexOf("async function retry("),
      homeSource.indexOf("if (data.failedRuns.length === 0)"),
    );
    assert.ok(retry.length > 0, "retry handler not found");
    assert.match(retry, /routines\/\$\{r\.routineId\}\/run/);
    assert.match(retry, /runs\/\$\{r\.runId\}\/dismiss/);
    // The run may already have sent the email or moved the money, so the retry
    // asks first rather than firing on a stray click.
    assert.match(retry, /dialog\.confirm\(/);
  });
});
