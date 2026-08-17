import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const homeSource = fs.readFileSync(path.join(appRoot, "client/pages/Home.tsx"), "utf8");

/**
 * The Home "Failed routines" panel is the only place a member sees an
 * interrupted Run without opening the routine, so the redo lives there. These
 * assertions guard the two halves of that affordance that are easy to lose in a
 * refactor: it is offered on interrupted Runs only, and taking it retires the
 * row it came from.
 */
describe("Home failed-routines rerun", () => {
  test("the rerun button is gated on the interrupted status", () => {
    assert.match(homeSource, /r\.status === "interrupted" && \(\s*<button/);
  });

  test("rerunning triggers the routine and dismisses the interrupted run", () => {
    const rerun = homeSource.slice(
      homeSource.indexOf("async function rerun("),
      homeSource.indexOf("if (data.failedRuns.length === 0)"),
    );
    assert.ok(rerun.length > 0, "rerun handler not found");
    assert.match(rerun, /routines\/\$\{r\.routineId\}\/run/);
    assert.match(rerun, /runs\/\$\{r\.runId\}\/dismiss/);
    // An interrupted run may already have sent the email or moved the money,
    // so the redo asks first rather than firing on a stray click.
    assert.match(rerun, /dialog\.confirm\(/);
  });
});
