import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canHandToChat, startingEmployeeId } from "./useInitiativeRequest.js";

/**
 * The rules for asking an AI Employee for standing work, shared by Ask AI
 * Employee on Proactive and New routine: who a request starts out addressed
 * to, and when it may become a Chat draft.
 */

describe("startingEmployeeId", () => {
  const ada = { id: "ada" };
  const bo = { id: "bo" };

  test("a company with one AI Employee has nobody else to ask", () => {
    assert.equal(startingEmployeeId([ada]), "ada");
  });

  test("with several, nobody is chosen until the Member chooses", () => {
    assert.equal(startingEmployeeId([ada, bo]), "");
    assert.equal(startingEmployeeId([]), "");
  });

  test("the employee a list was narrowed to is chosen when they can be asked", () => {
    assert.equal(startingEmployeeId([ada, bo], "bo"), "bo");
    assert.equal(startingEmployeeId([ada], "ada"), "ada");
  });

  test("a preferred employee who is not on offer is ignored", () => {
    assert.equal(startingEmployeeId([ada, bo], "cy"), "");
    assert.equal(startingEmployeeId([ada], "cy"), "ada", "the only one still wins");
    assert.equal(startingEmployeeId([ada, bo], null), "");
  });
});

describe("canHandToChat", () => {
  const ready = { chatReady: true };

  test("needs someone to ask, who can answer, and something to say", () => {
    assert.equal(canHandToChat({ employee: ready, unsentDraft: false, request: "Weekly" }), true);
    assert.equal(
      canHandToChat({ employee: undefined, unsentDraft: false, request: "Weekly" }),
      false,
    );
    assert.equal(
      canHandToChat({ employee: { chatReady: false }, unsentDraft: false, request: "Weekly" }),
      false,
    );
    assert.equal(canHandToChat({ employee: {}, unsentDraft: false, request: "Weekly" }), false);
    assert.equal(canHandToChat({ employee: ready, unsentDraft: false, request: "" }), false);
    assert.equal(canHandToChat({ employee: ready, unsentDraft: false, request: " \n " }), false);
  });

  test("never buries a Chat draft nobody has sent", () => {
    assert.equal(canHandToChat({ employee: ready, unsentDraft: true, request: "Weekly" }), false);
  });
});
