import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { defaultAnswers, EMPTY_ANSWERS, generateSoul } from "./soulDraft.js";

const TEMPLATE = { tagline: "Guards the calendar and triages the inbox." };

describe("drafting a Soul from the About answers", () => {
  test("Reference material starts empty, so no stand-in links are offered", () => {
    assert.equal(defaultAnswers("Executive Assistant").reference, "");
    assert.equal(EMPTY_ANSWERS.reference, "");
  });

  test("an empty Reference leaves its section out, with no placeholder links", () => {
    const soul = generateSoul("Avery", "Executive Assistant", TEMPLATE, defaultAnswers("EA"));
    assert.doesNotMatch(soul, /Reference material/);
    assert.doesNotMatch(soul, /notion\.so|linear\.app|your-company/);
    assert.match(soul, /## What you refuse to do/);
  });

  test("a Reference of only whitespace counts as empty", () => {
    const soul = generateSoul("Avery", "Assistant", TEMPLATE, {
      ...defaultAnswers("Assistant"),
      reference: "  \n \n",
    });
    assert.doesNotMatch(soul, /Reference material/);
  });

  test("references the person wrote become a bulleted section at the end", () => {
    const soul = generateSoul("Avery", "Assistant", TEMPLATE, {
      ...defaultAnswers("Assistant"),
      reference: "https://example.test/voice\n- https://example.test/escalation",
    });
    assert.match(
      soul,
      /## Reference material\n- https:\/\/example\.test\/voice\n- https:\/\/example\.test\/escalation\n$/,
    );
  });

  test("their own answers are used, and blank ones fall back to the plain defaults", () => {
    const soul = generateSoul("Sam", "Engineer", null, {
      ...EMPTY_ANSWERS,
      mission: "Ship  reliable\nreleases.",
    });
    assert.match(soul, /^# Sam's Soul/);
    assert.match(soul, /## Your mission\nShip reliable releases\.\n/);
    assert.match(soul, /Never send, publish, or commit money without human sign-off\./);
    assert.match(soul, /You are \*\*Sam\*\*, our Engineer\. You know the company/);
  });

  test("a template lends its tagline to who they are", () => {
    const soul = generateSoul("Avery", "Executive Assistant", TEMPLATE, EMPTY_ANSWERS);
    assert.match(soul, /You are \*\*Avery\*\*, our Executive Assistant\. Guards the calendar/);
  });
});
