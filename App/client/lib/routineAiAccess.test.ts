import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RoutineAccessLevel, RoutineAccessRow } from "./api";
import {
  DEFAULT_ROUTINE_ACCESS_LEVEL,
  ROUTINE_ACCESS_LEVELS,
  canManageRoutineAccess,
  replaceRoutineAccessRow,
  routineAccessLevelLabel,
  summarizeRoutineAccess,
  withRoutineAccess,
} from "./routineAiAccess";

function row(id: string, accessLevel: RoutineAccessLevel, isDefault = false): RoutineAccessRow {
  return {
    employee: { id, name: id.toUpperCase(), slug: id, role: "Role", avatarKey: null },
    accessLevel,
    isDefault,
  };
}

describe("the Routines access levels", () => {
  test("are laid out narrowest first, with read + write the default", () => {
    assert.deepEqual(
      ROUTINE_ACCESS_LEVELS.map((level) => [level.value, level.label]),
      [
        ["run", "Read + run"],
        ["write", "Read + write"],
      ],
    );
    assert.equal(DEFAULT_ROUTINE_ACCESS_LEVEL, "write");
  });

  test("say plainly what each level keeps and takes away", () => {
    const [run, write] = ROUTINE_ACCESS_LEVELS;
    assert.match(run.hint, /keep running/);
    assert.match(run.hint, /Creates, edits, pauses, re-files, and deletes nothing/);
    assert.match(run.hint, /no AI employee can change its Routines/);
    assert.match(write.hint, /Everything in Read \+ run/);
    assert.match(write.hint, /create, edit, re-schedule, pause, re-file, and delete Routines/);
    // Vocabulary: Routines are never tasks, jobs, or workflows.
    for (const level of ROUTINE_ACCESS_LEVELS) {
      assert.doesNotMatch(
        `${level.label} ${level.tagline} ${level.hint}`,
        /\b(task|job|workflow)s?\b/i,
      );
    }
  });

  test("label each level, and read anything unknown as the narrower one", () => {
    assert.equal(routineAccessLevelLabel("run"), "Read + run");
    assert.equal(routineAccessLevelLabel("write"), "Read + write");
    assert.equal(routineAccessLevelLabel("superuser" as RoutineAccessLevel), "Read + run");
  });
});

describe("canManageRoutineAccess", () => {
  test("owners and admins change levels; Members and an unknown role only read", () => {
    assert.equal(canManageRoutineAccess("owner"), true);
    assert.equal(canManageRoutineAccess("admin"), true);
    assert.equal(canManageRoutineAccess("member"), false);
    assert.equal(canManageRoutineAccess(undefined), false);
  });
});

describe("withRoutineAccess", () => {
  test("moves one employee and marks it as no longer the default", () => {
    const rows = [row("ada", "write", true), row("bob", "write", true)];
    const next = withRoutineAccess(rows, "ada", "run");
    assert.deepEqual(next, [row("ada", "run", false), row("bob", "write", true)]);
    assert.deepEqual(rows, [row("ada", "write", true), row("bob", "write", true)], "not mutated");
  });

  test("returns the same array when nothing would change", () => {
    const rows = [row("ada", "run"), row("bob", "write", true)];
    assert.equal(withRoutineAccess(rows, "ada", "run"), rows);
    assert.equal(withRoutineAccess(rows, "nobody", "run"), rows);
  });
});

describe("replaceRoutineAccessRow", () => {
  test("puts the server's copy back in place, keeping order", () => {
    const rows = [row("ada", "run"), row("bob", "write", true), row("cy", "write", true)];
    const saved = {
      ...row("bob", "run"),
      employee: { ...row("bob", "run").employee, name: "Bob B." },
    };
    assert.deepEqual(replaceRoutineAccessRow(rows, saved), [rows[0], saved, rows[2]]);
  });

  test("restores a rolled-back row exactly", () => {
    const original = row("ada", "write", true);
    const optimistic = withRoutineAccess([original, row("bob", "run")], "ada", "run");
    assert.deepEqual(replaceRoutineAccessRow(optimistic, original), [original, row("bob", "run")]);
  });

  test("ignores a row the list does not hold", () => {
    const rows = [row("ada", "run")];
    assert.equal(replaceRoutineAccessRow(rows, row("ghost", "write")), rows);
  });
});

describe("summarizeRoutineAccess", () => {
  test("counts the read + run exceptions against the roster", () => {
    assert.equal(summarizeRoutineAccess([]), "");
    assert.equal(summarizeRoutineAccess([row("ada", "write", true)]), "Read + write");
    assert.equal(
      summarizeRoutineAccess([row("ada", "write", true), row("bob", "write")]),
      "All 2 read + write",
    );
    assert.equal(
      summarizeRoutineAccess([row("ada", "run"), row("bob", "write"), row("cy", "write", true)]),
      "1 of 3 read + run",
    );
    assert.equal(summarizeRoutineAccess([row("ada", "run")]), "1 of 1 read + run");
  });
});
