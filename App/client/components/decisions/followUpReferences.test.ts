import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  markReferenceSeen,
  parseFollowReferences,
  unseenReferences,
  type FollowReference,
} from "./useDecisionFollowUps.js";

/**
 * The rows a Member follows after answering, sending or approving are kept in
 * their browser by identity only. A row whose work finished cleanly is marked
 * `seen` once its last line has been on screen, and the next visit leaves it
 * behind — that is what spares the Close click. These pin the stored shape.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseFollowReferences", () => {
  test("reads identities, keeping seen only as true", () => {
    assert.deepEqual(
      parseFollowReferences(
        JSON.stringify([
          { kind: "decision", id: A },
          { kind: "review", id: B, seen: true },
        ]),
      ),
      [
        { kind: "decision", id: A },
        { kind: "review", id: B, seen: true },
      ],
    );
  });

  test("an empty or missing list is empty", () => {
    assert.deepEqual(parseFollowReferences(null), []);
    assert.deepEqual(parseFollowReferences("[]"), []);
    assert.deepEqual(parseFollowReferences('{"kind":"decision"}'), []);
  });

  test("an unreadable value is null, so callers can tell it from an empty list", () => {
    assert.equal(parseFollowReferences("{not json"), null);
  });

  test("drops anything that is not an identity, and repeats", () => {
    assert.deepEqual(
      parseFollowReferences(
        JSON.stringify([
          null,
          "decision-x",
          { kind: "approval", id: A },
          { kind: "decision", id: 7 },
          { kind: "decision", id: "../../etc/passwd" },
          { kind: "decision", id: "x".repeat(101) },
          { kind: "decision", id: A },
          { kind: "decision", id: A, seen: true },
        ]),
      ),
      [{ kind: "decision", id: A }],
    );
  });

  test("never keeps anything but the identity and the seen mark", () => {
    const parsed = parseFollowReferences(
      JSON.stringify([
        { kind: "decision", id: A, seen: "yes", title: "Sign Acme?", body: "private" },
      ]),
    );
    assert.deepEqual(parsed, [{ kind: "decision", id: A }]);
    assert.doesNotMatch(JSON.stringify(parsed), /Acme|private|yes/);
  });
});

describe("unseenReferences", () => {
  test("a new visit leaves rows already seen finished behind, in order", () => {
    const list: FollowReference[] = [
      { kind: "decision", id: A, seen: true },
      { kind: "review", id: B },
      { kind: "decision", id: B },
    ];
    assert.deepEqual(unseenReferences(list), [
      { kind: "review", id: B },
      { kind: "decision", id: B },
    ]);
    assert.deepEqual(unseenReferences([]), []);
  });
});

describe("markReferenceSeen", () => {
  test("marks only the matching row, by kind and id", () => {
    const list: FollowReference[] = [
      { kind: "decision", id: A },
      { kind: "review", id: A },
    ];
    assert.deepEqual(markReferenceSeen(list, `review-${A}`), [
      { kind: "decision", id: A },
      { kind: "review", id: A, seen: true },
    ]);
    // The input is left alone.
    assert.deepEqual(list, [
      { kind: "decision", id: A },
      { kind: "review", id: A },
    ]);
  });

  test("returns null when nothing changes, so storage is not rewritten", () => {
    assert.equal(
      markReferenceSeen([{ kind: "decision", id: A, seen: true }], `decision-${A}`),
      null,
    );
    // A row this Member does not follow is never added by being seen.
    assert.equal(markReferenceSeen([{ kind: "decision", id: A }], `decision-${B}`), null);
    assert.equal(markReferenceSeen([], `decision-${A}`), null);
  });

  test("round-trips through storage", () => {
    const marked = markReferenceSeen([{ kind: "decision", id: A }], `decision-${A}`);
    assert.ok(marked);
    assert.deepEqual(unseenReferences(parseFollowReferences(JSON.stringify(marked)) ?? []), []);
  });
});
