import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildInitiativeRequestPrompt, MAX_INITIATIVE_REQUEST_LENGTH } from "./initiativePrompt.js";
import { ROUTINE_EXAMPLES, examplesStayOnOffer } from "./routineExamples.js";

/**
 * The chips under "What should happen, and how often?" fill the box with a
 * whole request, so each must be one the page can really hand to an AI
 * Employee, and they must not stand over words the person wrote themselves.
 */

describe("ROUTINE_EXAMPLES", () => {
  test("offers three or four, each with a distinct label", () => {
    assert.ok(ROUTINE_EXAMPLES.length >= 3 && ROUTINE_EXAMPLES.length <= 4);
    assert.equal(
      new Set(ROUTINE_EXAMPLES.map((example) => example.label)).size,
      ROUTINE_EXAMPLES.length,
    );
  });

  test("each fills the box with a request the hand-off accepts, saying how often", () => {
    for (const example of ROUTINE_EXAMPLES) {
      assert.ok(example.request.length <= MAX_INITIATIVE_REQUEST_LENGTH, example.label);
      assert.doesNotThrow(() => buildInitiativeRequestPrompt(example.request), example.label);
      assert.match(example.request, /\bevery\b/i, `${example.label} says how often`);
    }
  });
});

describe("examplesStayOnOffer", () => {
  test("stay while the box is empty or holds only blank space", () => {
    assert.equal(examplesStayOnOffer(""), true);
    assert.equal(examplesStayOnOffer("  \n"), true);
  });

  test("stay while the box still holds one of them exactly, so another can be tried", () => {
    for (const example of ROUTINE_EXAMPLES) {
      assert.equal(examplesStayOnOffer(example.request), true, example.label);
    }
  });

  test("step aside once the person has written or edited their own words", () => {
    assert.equal(examplesStayOnOffer("Check the support inbox every hour."), false);
    assert.equal(examplesStayOnOffer(`${ROUTINE_EXAMPLES[0].request} Also flag refunds.`), false);
    assert.equal(examplesStayOnOffer(ROUTINE_EXAMPLES[0].request.slice(0, -1)), false);
  });
});
