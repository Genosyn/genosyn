import assert from "node:assert/strict";
import { test } from "node:test";

import { PALETTE_SUBPAGES } from "./subpages.js";
import { waitingLinks } from "./waitingElsewhere.js";

test("names each queue that holds something, in the singular when it holds one", () => {
  assert.deepEqual(
    waitingLinks({
      approvals: 3,
      revisions: 1,
      initiatives: 0,
      todoReviews: 2,
      financeProposals: null,
    }).map((link) => link.label),
    ["3 Approvals", "1 Revision", "2 todos to review"],
  );
});

test("says nothing until the counts arrive, or when nothing else waits", () => {
  assert.deepEqual(waitingLinks(null), []);
  assert.deepEqual(
    waitingLinks({
      approvals: null,
      revisions: null,
      initiatives: null,
      todoReviews: 0,
      financeProposals: null,
    }),
    [],
  );
});

test("links every queue to a catalogued page", () => {
  const links = waitingLinks({
    approvals: 1,
    revisions: 1,
    initiatives: 1,
    todoReviews: 1,
    financeProposals: 1,
  });
  assert.equal(links.length, 5);
  for (const link of links) {
    assert.ok(
      PALETTE_SUBPAGES.some((page) => page.path === link.path),
      `${link.path} is a catalogued page`,
    );
  }
});
