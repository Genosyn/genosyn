import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Routine } from "../db/entities/Routine.js";
import { isUnwrittenRoutineBrief, routineTemplate } from "./files.js";
import { awaitingRoutineBrief, startingRoutineBrief, writeRoutineBrief } from "./routineBrief.js";

describe("startingRoutineBrief", () => {
  const routine = { name: "Digest", cronExpr: "0 9 * * 1-5" };
  const outline = routineTemplate(routine.name, routine.cronExpr);

  test("a brief that says something is the body, kept as written, and starts the Routine on", () => {
    for (const brief of ["Post the digest.", "  Post the digest.\n"]) {
      assert.deepEqual(startingRoutineBrief({ ...routine, brief }), {
        body: brief,
        enabled: true,
      });
    }
  });

  test("no brief, a blank one, or the starter outline untouched starts paused on the outline", () => {
    for (const brief of [undefined, null, "", " \n\t", outline]) {
      assert.deepEqual(startingRoutineBrief({ ...routine, brief }), {
        body: outline,
        enabled: false,
      });
    }
  });

  test("the outline carries the name and schedule the Routine was created with", () => {
    const start = startingRoutineBrief({ name: "Month end", cronExpr: "0 8 1 * *" });
    assert.match(start.body, /^# Month end\n\n\*\*Schedule:\*\* `0 8 1 \* \*`\n/);
  });
});

describe("isUnwrittenRoutineBrief", () => {
  test("a blank brief and the starter outline, under any title and schedule, are unwritten", () => {
    for (const body of [
      "",
      " \n\t",
      routineTemplate("Weekly digest", "0 9 * * 1-5"),
      routineTemplate("A renamed: `odd` title", "*/15 * * * *"),
    ]) {
      assert.equal(isUnwrittenRoutineBrief(body), true, JSON.stringify(body));
    }
  });

  test("any change to the outline itself counts as written", () => {
    const outline = routineTemplate("Weekly digest", "0 9 * * 1-5");
    for (const body of [
      outline.replace("What this routine is meant to achieve on each run.", "Ship the digest."),
      `${outline}\nPost it to #general.\n`,
      outline.trimEnd(),
      "# Weekly digest",
      "Post the digest to #general.",
    ]) {
      assert.equal(isUnwrittenRoutineBrief(body), false, JSON.stringify(body));
    }
  });
});

describe("writeRoutineBrief", () => {
  const routine = (enabled: boolean, body: string) =>
    Object.assign(new Routine(), { enabled, body, cronExpr: "0 9 * * 1-5", nextRunAt: null });

  test("the first brief written into a paused Routine switches it on and schedules it", () => {
    const r = routine(false, routineTemplate("Digest", "0 9 * * 1-5"));
    assert.equal(awaitingRoutineBrief(r), true);
    assert.equal(writeRoutineBrief(r, "Post the digest."), true);
    assert.equal(r.enabled, true);
    assert.ok(r.nextRunAt);
    assert.equal(r.body, "Post the digest.");
    assert.equal(awaitingRoutineBrief(r), false);
  });

  test("a blank brief is saved but leaves the Routine paused and waiting", () => {
    const r = routine(false, routineTemplate("Digest", "0 9 * * 1-5"));
    assert.equal(writeRoutineBrief(r, "   "), false);
    assert.equal(r.enabled, false);
    assert.equal(r.nextRunAt, null);
    assert.equal(r.body, "   ");
    assert.equal(awaitingRoutineBrief(r), true);
  });

  test("a Routine already on, or paused after its brief was written, keeps its switch", () => {
    for (const r of [
      routine(true, routineTemplate("Digest", "0 9 * * 1-5")),
      routine(false, "Old"),
    ]) {
      const enabled = r.enabled;
      assert.equal(writeRoutineBrief(r, "New brief."), false);
      assert.equal(r.enabled, enabled);
      assert.equal(r.body, "New brief.");
    }
  });
});
