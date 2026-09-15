import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PublicBaseFormQuestion } from "../../lib/api.js";
import { FormQuestionInput } from "./FormQuestionInput.js";

const question: PublicBaseFormQuestion = {
  id: "00000000-0000-4000-8000-000000000001",
  label: "Which region should we contact?",
  description: "Choose the closest team.",
  required: true,
  type: "select",
  options: [{ id: "emea", label: "EMEA", color: "indigo" }],
};

describe("FormQuestionInput choice groups", () => {
  test("names and describes custom choice controls programmatically", () => {
    const html = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question,
        value: "",
        onChange: () => undefined,
        invalid: true,
        ariaLabelledBy: "question-label",
        ariaDescribedBy: "question-help question-error",
      }),
    );

    assert.match(html, /<fieldset\b/);
    assert.match(html, /aria-labelledby="question-label"/);
    assert.match(html, /aria-describedby="question-help question-error"/);
    assert.match(html, /<legend[^>]*>Which region should we contact\?<\/legend>/);
    assert.match(html, /<input[^>]*type="radio"[^>]*required=""/);
    assert.match(html, /focus-within:ring-2/);
  });
});
