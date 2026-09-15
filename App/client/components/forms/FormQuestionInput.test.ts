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

function questionOf(
  type: PublicBaseFormQuestion["type"],
  over: Partial<PublicBaseFormQuestion> = {},
): PublicBaseFormQuestion {
  return {
    ...question,
    id: `question-${type}`,
    type,
    options:
      type === "select" || type === "multiselect"
        ? [
            { id: "emea", label: "EMEA", color: "indigo" },
            { id: "americas", label: "Americas", color: "emerald" },
          ]
        : [],
    ...over,
  };
}

type TestElement = React.ReactElement<Record<string, unknown>>;

function allElements(node: React.ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements);
  if (!React.isValidElement(node)) return [];
  const element = node as TestElement;
  return [element, ...allElements(element.props.children as React.ReactNode)];
}

function directRender(
  current: PublicBaseFormQuestion,
  value: React.ComponentProps<typeof FormQuestionInput>["value"],
  onChange: React.ComponentProps<typeof FormQuestionInput>["onChange"],
): TestElement {
  return FormQuestionInput({ question: current, value, onChange }) as TestElement;
}

function findControl(root: TestElement, type: string, value?: string): TestElement {
  const found = allElements(root).find(
    (element) =>
      element.type === "input" &&
      element.props.type === type &&
      (value === undefined || element.props.value === value),
  );
  assert.ok(found, `Expected ${type} control${value ? ` for ${value}` : ""}`);
  return found;
}

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

  test("uses one named radio group and independent checkboxes", () => {
    const single = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("select"),
        value: "emea",
        onChange: () => undefined,
      }),
    );
    assert.equal((single.match(/type="radio"/g) ?? []).length, 2);
    assert.equal((single.match(/name="form-question-question-select"/g) ?? []).length, 2);
    assert.equal((single.match(/checked=""/g) ?? []).length, 1);

    const multiple = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("multiselect"),
        value: ["emea", "americas"],
        onChange: () => undefined,
      }),
    );
    assert.equal((multiple.match(/type="checkbox"/g) ?? []).length, 2);
    assert.equal((multiple.match(/checked=""/g) ?? []).length, 2);
    assert.doesNotMatch(multiple, /name="form-question-/);
  });

  test("renders an explicit empty-choice state instead of an unusable blank group", () => {
    const html = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("select", { options: [] }),
        value: "",
        onChange: () => undefined,
      }),
    );
    assert.match(html, /No choices have been added yet/);
    assert.doesNotMatch(html, /type="radio"/);
  });

  test("select emits one option id and multiple select toggles without mutating input", () => {
    const selected: unknown[] = [];
    const single = directRender(questionOf("select"), "", (value) => selected.push(value));
    const emeaRadio = findControl(single, "radio");
    (emeaRadio.props.onChange as () => void)();
    assert.deepEqual(selected, ["emea"]);

    const changes: unknown[] = [];
    const initial = ["emea"];
    const multiple = directRender(questionOf("multiselect"), initial, (value) =>
      changes.push(value),
    );
    const controls = allElements(multiple).filter(
      (element) => element.type === "input" && element.props.type === "checkbox",
    );
    (controls[0].props.onChange as () => void)();
    (controls[1].props.onChange as () => void)();
    assert.deepEqual(changes, [[], ["emea", "americas"]]);
    assert.deepEqual(initial, ["emea"]);
  });
});

describe("FormQuestionInput scalar controls", () => {
  test("renders every scalar field as its native browser control", () => {
    const expected = {
      text: { tag: "input", type: "text" },
      longtext: { tag: "textarea", type: null },
      number: { tag: "input", type: "number" },
      checkbox: { tag: "input", type: "checkbox" },
      date: { tag: "input", type: "date" },
      datetime: { tag: "input", type: "datetime-local" },
      email: { tag: "input", type: "email" },
      url: { tag: "input", type: "url" },
    } as const;
    for (const [type, control] of Object.entries(expected)) {
      const html = renderToStaticMarkup(
        React.createElement(FormQuestionInput, {
          question: questionOf(type as keyof typeof expected),
          value: type === "checkbox" ? false : "",
          onChange: () => undefined,
        }),
      );
      assert.match(html, new RegExp(`<${control.tag}\\b`), type);
      if (control.type) assert.match(html, new RegExp(`type="${control.type}"`), type);
    }
  });

  test("preserves values and the correct input hints", () => {
    const number = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("number"),
        value: 12.5,
        onChange: () => undefined,
      }),
    );
    assert.match(number, /value="12\.5"/);
    assert.match(number, /inputMode="decimal"|inputmode="decimal"/);

    const url = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("url"),
        value: "https://example.test",
        onChange: () => undefined,
      }),
    );
    assert.match(url, /value="https:\/\/example\.test"/);
    assert.match(url, /placeholder="https:\/\/…"/);

    const longtext = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("longtext"),
        value: "A longer answer",
        onChange: () => undefined,
      }),
    );
    assert.match(longtext, />A longer answer<\/textarea>/);
    assert.match(longtext, /rows="4"/);
  });

  test("carries required, invalid, described-by, and disabled state to native controls", () => {
    const html = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("email", { required: true }),
        value: "wrong",
        onChange: () => undefined,
        disabled: true,
        invalid: true,
        ariaDescribedBy: "help error",
      }),
    );
    assert.match(html, /required=""/);
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /aria-describedby="help error"/);
    assert.match(html, /border-rose-400/);
  });

  test("converts number input to finite numbers while preserving an empty answer", () => {
    const changes: unknown[] = [];
    const root = directRender(questionOf("number"), "", (value) => changes.push(value));
    const input = findControl(root, "number");
    const onChange = input.props.onChange as (event: { target: { value: string } }) => void;
    onChange({ target: { value: "12.75" } });
    onChange({ target: { value: "" } });
    assert.deepEqual(changes, [12.75, ""]);
  });

  test("emits text, long-text, and checkbox values without coercing them", () => {
    const changes: unknown[] = [];
    const text = directRender(questionOf("text"), "", (value) => changes.push(value));
    (findControl(text, "text").props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "Ada" },
    });
    const longtext = directRender(questionOf("longtext"), "", (value) => changes.push(value));
    (
      longtext.props.onChange as (event: { target: { value: string } }) => void
    )({ target: { value: "Long answer" } });
    const checkbox = directRender(questionOf("checkbox"), false, (value) => changes.push(value));
    (findControl(checkbox, "checkbox").props.onChange as (event: {
      target: { checked: boolean };
    }) => void)({ target: { checked: true } });
    assert.deepEqual(changes, ["Ada", "Long answer", true]);
  });

  test("escapes question and option copy rather than treating it as markup", () => {
    const html = renderToStaticMarkup(
      React.createElement(FormQuestionInput, {
        question: questionOf("select", {
          label: '<img src=x onerror="bad()">',
          options: [{ id: "one", label: "<script>bad()</script>", color: "indigo" }],
        }),
        value: "",
        onChange: () => undefined,
      }),
    );
    assert.match(html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|<img\b/);
  });
});
