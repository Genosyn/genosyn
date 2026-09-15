import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BaseField, BaseForm, BaseFormQuestion, PublicBaseFormQuestion } from "./api";
import {
  PUBLIC_FORM_FIELD_TYPES,
  baseFormPublishBlocker,
  baseFormShareState,
  baseFormStatus,
  createBaseFormQuestion,
  createClientUuid,
  editableBaseForm,
  equivalentEditableBaseForms,
  formFieldTypeLabel,
  initialPublicFormValues,
  isPublicFormFieldType,
  moveBaseFormQuestion,
  preparePublicFormSubmission,
  publicFormFields,
  publicFormRequiredProgress,
  publicFormUrlNotice,
  publicFormValueIsAnswered,
  removeBaseFormQuestion,
  selectOptionsForField,
  updateBaseFormQuestion,
  validatePublicFormValues,
} from "./baseForms";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function field(
  id: string,
  type: BaseField["type"] = "text",
  config: Record<string, unknown> = {},
): BaseField {
  return {
    id,
    tableId: "table",
    name: `Field ${id}`,
    type,
    config,
    isPrimary: false,
    sortOrder: 1,
  };
}

function question(
  id: string,
  type: PublicBaseFormQuestion["type"] = "text",
  over: Partial<PublicBaseFormQuestion> = {},
): PublicBaseFormQuestion {
  return {
    id,
    label: `Question ${id}`,
    description: "",
    required: false,
    type,
    options: [],
    ...over,
  };
}

function form(over: Partial<BaseForm> = {}): BaseForm {
  return {
    id: "form",
    tableId: "table",
    slug: "contact",
    title: "Contact us",
    description: "Tell us how we can help.",
    submitLabel: "Send response",
    successTitle: "Thank you",
    successMessage: "We received it.",
    allowAnotherResponse: false,
    publishedAt: null,
    acceptingResponses: false,
    publicUrl: null,
    publicUrlConfigured: true,
    responseCount: 0,
    lastResponseAt: null,
    questions: [],
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:00:00.000Z",
    ...over,
  };
}

function editorQuestion(id: string, fieldId = `field-${id}`): BaseFormQuestion {
  return { id, fieldId, label: `Question ${id}`, description: "", required: false };
}

describe("createClientUuid", () => {
  test("uses randomUUID when the browser exposes it", () => {
    const expected = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(createClientUuid({ randomUUID: () => expected }), expected);
  });

  test("builds a valid UUID when randomUUID is unavailable on HTTP", () => {
    const id = createClientUuid({
      getRandomValues(values) {
        values.fill(0);
        return values;
      },
    });
    assert.equal(id, "00000000-0000-4000-8000-000000000000");
    assert.match(id, UUID_V4_PATTERN);
  });

  test("still returns a valid UUID when Web Crypto is unavailable", () => {
    assert.match(createClientUuid(null), UUID_V4_PATTERN);
  });

  test("rejects an invalid randomUUID result and uses random bytes instead", () => {
    const id = createClientUuid({
      randomUUID: () => "not-a-uuid",
      getRandomValues(values) {
        values.fill(255);
        return values;
      },
    });
    assert.equal(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.match(id, UUID_V4_PATTERN);
  });

  test("recovers when randomUUID throws in an insecure browser context", () => {
    assert.equal(
      createClientUuid({
        randomUUID() {
          throw new Error("secure context required");
        },
        getRandomValues(values) {
          values.fill(17);
          return values;
        },
      }),
      "11111111-1111-4111-9111-111111111111",
    );
  });
});

describe("editor question operations", () => {
  test("creates a question that writes to a supported table field", () => {
    const created = createBaseFormQuestion(
      { ...field("email", "email"), name: "Email address" },
      "00000000-0000-4000-8000-000000000001",
    );
    assert.deepEqual(created, {
      id: "00000000-0000-4000-8000-000000000001",
      fieldId: "email",
      label: "Email address",
      description: "",
      required: false,
    });
  });

  test("will not create public questions for links or private resources", () => {
    for (const type of [
      "link",
      "customer",
      "invoice",
      "project",
      "employee",
      "member",
      "note",
      "pipeline",
    ] as const) {
      assert.equal(createBaseFormQuestion(field(type, type)), null, type);
    }
  });

  test("updates only the selected question without mutating the draft", () => {
    const before = [editorQuestion("one"), editorQuestion("two")];
    const next = updateBaseFormQuestion(before, "two", {
      label: "A clearer question",
      required: true,
    });
    assert.notEqual(next, before);
    assert.equal(next[0], before[0]);
    assert.notEqual(next[1], before[1]);
    assert.equal(before[1].label, "Question two");
    assert.deepEqual(next[1], {
      ...before[1],
      label: "A clearer question",
      required: true,
    });
  });

  test("moves questions in either direction without mutating their order", () => {
    const before = [editorQuestion("one"), editorQuestion("two"), editorQuestion("three")];
    assert.deepEqual(
      moveBaseFormQuestion(before, "two", -1).map((item) => item.id),
      ["two", "one", "three"],
    );
    assert.deepEqual(
      moveBaseFormQuestion(before, "two", 1).map((item) => item.id),
      ["one", "three", "two"],
    );
    assert.deepEqual(
      before.map((item) => item.id),
      ["one", "two", "three"],
    );
  });

  test("ignores moves beyond either edge and unknown ids", () => {
    const before = [editorQuestion("one"), editorQuestion("two")];
    assert.equal(moveBaseFormQuestion(before, "one", -1), before);
    assert.equal(moveBaseFormQuestion(before, "two", 1), before);
    assert.equal(moveBaseFormQuestion(before, "missing", 1), before);
  });

  test("removes only the selected question", () => {
    const before = [editorQuestion("one"), editorQuestion("two"), editorQuestion("three")];
    assert.deepEqual(
      removeBaseFormQuestion(before, "two").map((item) => item.id),
      ["one", "three"],
    );
    assert.equal(before.length, 3);
  });
});

describe("editor dirty state", () => {
  test("includes every field sent by Save changes", () => {
    const current = form({ questions: [editorQuestion("one")] });
    assert.deepEqual(editableBaseForm(current), {
      title: current.title,
      description: current.description,
      submitLabel: current.submitLabel,
      successTitle: current.successTitle,
      successMessage: current.successMessage,
      allowAnotherResponse: current.allowAnotherResponse,
      questions: current.questions,
    });
  });

  test("does not mark live response counts or publication changes as unsaved edits", () => {
    const persisted = form({ questions: [editorQuestion("one")] });
    assert.equal(
      equivalentEditableBaseForms(persisted, {
        ...persisted,
        responseCount: 12,
        lastResponseAt: "2026-09-15T13:00:00.000Z",
        publishedAt: "2026-09-15T12:30:00.000Z",
        acceptingResponses: true,
        publicUrl: "https://forms.example.test/forms/token",
        updatedAt: "2026-09-15T13:00:00.000Z",
      }),
      true,
    );
  });

  test("detects copy, setting, order, and question edits", () => {
    const persisted = form({ questions: [editorQuestion("one"), editorQuestion("two")] });
    const edits: BaseForm[] = [
      { ...persisted, title: "Changed" },
      { ...persisted, description: "Changed" },
      { ...persisted, submitLabel: "Changed" },
      { ...persisted, successTitle: "Changed" },
      { ...persisted, successMessage: "Changed" },
      { ...persisted, allowAnotherResponse: true },
      { ...persisted, questions: [...persisted.questions].reverse() },
      {
        ...persisted,
        questions: updateBaseFormQuestion(persisted.questions, "one", { required: true }),
      },
    ];
    for (const edited of edits) assert.equal(equivalentEditableBaseForms(persisted, edited), false);
  });

  test("handles the editor's loading and missing states", () => {
    assert.equal(equivalentEditableBaseForms(null, null), true);
    assert.equal(equivalentEditableBaseForms(form(), null), false);
    assert.equal(equivalentEditableBaseForms(null, form()), false);
  });
});

describe("baseFormStatus", () => {
  test("shows an archived table's form as unavailable instead of live", () => {
    const form = { publishedAt: "2026-09-15T12:00:00.000Z", acceptingResponses: true };
    assert.deepEqual(baseFormStatus(form), { label: "Live", tone: "emerald" });
    assert.deepEqual(baseFormStatus(form, true), { label: "Unavailable", tone: "amber" });
  });

  test("distinguishes draft, closed, and live forms", () => {
    assert.deepEqual(baseFormStatus(form()), { label: "Draft", tone: "slate" });
    assert.deepEqual(
      baseFormStatus(form({ publishedAt: "2026-09-15T12:00:00.000Z" })),
      { label: "Closed", tone: "amber" },
    );
    assert.deepEqual(
      baseFormStatus(
        form({ publishedAt: "2026-09-15T12:00:00.000Z", acceptingResponses: true }),
      ),
      { label: "Live", tone: "emerald" },
    );
  });
});

describe("publicFormUrlNotice", () => {
  test("always identifies localhost and loopback links as local-only", () => {
    assert.equal(publicFormUrlNotice("http://localhost:8471/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("http://127.0.0.1:8471/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("http://[::1]:8471/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("https://forms.localhost/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("http://0.0.0.0/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("https://127.255.0.1/forms/token", true), "local-only");
  });

  test("distinguishes off-host HTTP from a configured HTTPS public URL", () => {
    assert.equal(
      publicFormUrlNotice("http://forms.example.test/forms/token", true),
      "insecure-http",
    );
    assert.equal(publicFormUrlNotice("https://forms.example.test/forms/token", true), null);
    assert.equal(
      publicFormUrlNotice("https://forms.example.test/forms/token", false),
      "unconfigured",
    );
  });

  test("handles absent, malformed, and non-web links conservatively", () => {
    assert.equal(publicFormUrlNotice(null), null);
    assert.equal(publicFormUrlNotice(null, false), "unconfigured");
    assert.equal(publicFormUrlNotice("not a URL", true), "unconfigured");
    assert.equal(publicFormUrlNotice("/forms/token", true), "unconfigured");
    assert.equal(publicFormUrlNotice("ftp://forms.example.test/forms/token", true), "insecure-http");
  });

  test("does not mistake lookalike hostnames for localhost", () => {
    assert.equal(
      publicFormUrlNotice("https://localhost.example.test/forms/token", true),
      null,
    );
    assert.equal(publicFormUrlNotice("https://127.example.test/forms/token", true), null);
  });
});

describe("public Form field types", () => {
  test("keeps the supported list complete, stable, and uniquely named", () => {
    assert.deepEqual(PUBLIC_FORM_FIELD_TYPES, [
      "text",
      "longtext",
      "number",
      "checkbox",
      "date",
      "datetime",
      "email",
      "url",
      "select",
      "multiselect",
    ]);
    assert.equal(new Set(PUBLIC_FORM_FIELD_TYPES).size, PUBLIC_FORM_FIELD_TYPES.length);
  });

  test("filters out links and every private resource field", () => {
    const fields = [
      ...PUBLIC_FORM_FIELD_TYPES.map((type) => field(type, type)),
      field("link", "link"),
      field("customer", "customer"),
      field("member", "member"),
      field("pipeline", "pipeline"),
    ];
    assert.deepEqual(
      publicFormFields(fields).map((item) => item.type),
      PUBLIC_FORM_FIELD_TYPES,
    );
    assert.equal(isPublicFormFieldType("link"), false);
    assert.equal(isPublicFormFieldType("employee"), false);
  });

  test("labels every answer type in product language", () => {
    assert.deepEqual(
      Object.fromEntries(PUBLIC_FORM_FIELD_TYPES.map((type) => [type, formFieldTypeLabel(type)])),
      {
        text: "Text",
        longtext: "Long text",
        number: "Number",
        checkbox: "Checkbox",
        date: "Date",
        datetime: "Date & time",
        email: "Email",
        url: "URL",
        select: "Single select",
        multiselect: "Multiple select",
      },
    );
  });
});

describe("selectOptionsForField", () => {
  function selectField(options: unknown[]): BaseField {
    return {
      id: "field",
      tableId: "table",
      name: "Region",
      type: "select",
      config: { options },
      isPrimary: false,
      sortOrder: 1,
    };
  }

  test("keeps only the same usable, unique options exposed by the public Form", () => {
    const longId = "i".repeat(256);
    const longLabel = "L".repeat(201);
    assert.deepEqual(
      selectOptionsForField(
        selectField([
          { id: "", label: "Empty id", color: "indigo" },
          { id: longId, label: "Long id", color: "indigo" },
          { id: "blank", label: "   ", color: "indigo" },
          { id: "long-label", label: longLabel, color: "indigo" },
          { id: "emea", label: "EMEA", color: "x".repeat(41) },
          { id: "emea", label: "Duplicate", color: "rose" },
          { id: "americas", label: "Americas" },
          { id: "apac", label: "  APAC  ", color: "emerald" },
        ]),
      ),
      [
        { id: "emea", label: "EMEA", color: "slate" },
        { id: "americas", label: "Americas", color: "slate" },
        { id: "apac", label: "APAC", color: "emerald" },
      ],
    );
  });

  test("does not inspect options beyond the public 100-option limit", () => {
    const ignored: unknown[] = Array.from({ length: 100 }, () => null);
    ignored.push({ id: "late", label: "Too late", color: "indigo" });
    assert.deepEqual(selectOptionsForField(selectField(ignored)), []);
  });

  test("returns no choices for a non-choice field or malformed config", () => {
    assert.deepEqual(selectOptionsForField(field("text", "text", { options: [] })), []);
    assert.deepEqual(selectOptionsForField(field("select", "select", { options: "EMEA" })), []);
    assert.deepEqual(selectOptionsForField(field("multi", "multiselect", {})), []);
  });
});

describe("publishing and sharing state", () => {
  const textField = field("name", "text");
  const choiceField = field("region", "select", {
    options: [{ id: "emea", label: "EMEA", color: "indigo" }],
  });
  const choiceQuestion = { ...editorQuestion("region", "region"), required: true };

  test("blocks an empty Form but permits a normal question", () => {
    assert.deepEqual(baseFormPublishBlocker(form(), [textField]), { kind: "no-questions" });
    assert.equal(
      baseFormPublishBlocker(form({ questions: [editorQuestion("name", "name")] }), [textField]),
      null,
    );
  });

  test("blocks required single- and multiple-choice questions without usable choices", () => {
    for (const type of ["select", "multiselect"] as const) {
      const emptyField = field("region", type, {
        options: [{ id: "blank", label: "   ", color: "indigo" }],
      });
      assert.deepEqual(
        baseFormPublishBlocker(form({ questions: [choiceQuestion] }), [emptyField]),
        { kind: "required-choice-without-options", question: choiceQuestion },
      );
    }
  });

  test("permits optional empty choices and required choices with one usable option", () => {
    assert.equal(
      baseFormPublishBlocker(
        form({ questions: [{ ...choiceQuestion, required: false }] }),
        [field("region", "select", { options: [] })],
      ),
      null,
    );
    assert.equal(
      baseFormPublishBlocker(form({ questions: [choiceQuestion] }), [choiceField]),
      null,
    );
  });

  test("classifies archived, draft, accepting, and closed share surfaces", () => {
    const draft = form({ questions: [editorQuestion("name", "name")] });
    assert.equal(baseFormShareState(draft, [textField], false).mode, "draft");
    assert.equal(baseFormShareState(draft, [textField], true).mode, "unavailable");
    const published = { ...draft, publishedAt: "2026-09-15T12:00:00.000Z" };
    assert.equal(baseFormShareState(published, [textField], false).mode, "closed");
    assert.equal(
      baseFormShareState({ ...published, acceptingResponses: true }, [textField], false).mode,
      "accepting",
    );
  });

  test("carries the publish blocker and URL warning into one share decision", () => {
    const state = baseFormShareState(
      form({ publicUrl: "http://localhost:8471/forms/token" }),
      [],
      false,
    );
    assert.equal(state.published, false);
    assert.equal(state.publishBlocked, true);
    assert.equal(state.publishBlocker?.kind, "no-questions");
    assert.equal(state.urlNotice, "local-only");
  });
});

describe("public response values", () => {
  const questions = [
    question("text", "text", { required: true }),
    question("long", "longtext"),
    question("number", "number", { required: true }),
    question("check", "checkbox", { required: true }),
    question("date", "date"),
    question("datetime", "datetime"),
    question("email", "email", { required: true }),
    question("url", "url", { required: true }),
    question("single", "select", {
      required: true,
      options: [{ id: "emea", label: "EMEA", color: "indigo" }],
    }),
    question("multi", "multiselect", {
      options: [{ id: "sales", label: "Sales", color: "emerald" }],
    }),
  ];

  test("initializes every supported control with its correct empty value", () => {
    assert.deepEqual(initialPublicFormValues(questions), {
      text: "",
      long: "",
      number: "",
      check: false,
      date: "",
      datetime: "",
      email: "",
      url: "",
      single: "",
      multi: [],
    });
  });

  test("defines answered consistently for strings, numbers, checkboxes, and multiple choice", () => {
    assert.equal(publicFormValueIsAnswered(questions[0], "  "), false);
    assert.equal(publicFormValueIsAnswered(questions[0], "Ada"), true);
    assert.equal(publicFormValueIsAnswered(questions[2], 0), true);
    assert.equal(publicFormValueIsAnswered(questions[2], Number.NaN), false);
    assert.equal(publicFormValueIsAnswered(questions[2], "12"), false);
    assert.equal(publicFormValueIsAnswered(questions[3], false), false);
    assert.equal(publicFormValueIsAnswered(questions[3], true), true);
    assert.equal(publicFormValueIsAnswered(questions[9], []), false);
    assert.equal(publicFormValueIsAnswered(questions[9], ["sales"]), true);
  });

  test("reports every missing required answer with checkbox-specific copy", () => {
    const errors = validatePublicFormValues(questions, initialPublicFormValues(questions));
    assert.deepEqual(errors, {
      text: "This question is required.",
      number: "This question is required.",
      check: "Check this box to continue.",
      email: "This question is required.",
      url: "This question is required.",
      single: "This question is required.",
    });
  });

  test("validates email and URL formats without rejecting blank optional answers", () => {
    const formatQuestions = [
      question("email", "email"),
      question("url", "url"),
      question("optional", "email"),
    ];
    assert.deepEqual(
      validatePublicFormValues(formatQuestions, {
        email: "not-an-email",
        url: "example.test/no-scheme",
        optional: "",
      }),
      {
        email: "Enter a valid email address.",
        url: "Enter a complete URL.",
      },
    );
    assert.deepEqual(
      validatePublicFormValues(formatQuestions, {
        email: "ada@example.test",
        url: "mailto:ada@example.test",
        optional: "  ",
      }),
      { url: "Enter a complete http or https URL." },
    );
    assert.deepEqual(
      validatePublicFormValues(formatQuestions, {
        email: "ada@example.test",
        url: "https://example.test/path?q=1",
        optional: "",
      }),
      {},
    );
  });

  test("tracks required progress using the same answered rules as submission", () => {
    const values = initialPublicFormValues(questions);
    assert.deepEqual(publicFormRequiredProgress(questions, values), {
      required: 6,
      completed: 0,
      percent: 0,
    });
    Object.assign(values, {
      text: "Ada",
      number: 0,
      check: true,
      email: "ada@example.test",
      url: "https://example.test",
      single: "emea",
    });
    assert.deepEqual(publicFormRequiredProgress(questions, values), {
      required: 6,
      completed: 6,
      percent: 100,
    });
    assert.deepEqual(publicFormRequiredProgress([question("optional")], { optional: "" }), {
      required: 0,
      completed: 0,
      percent: 100,
    });
  });

  test("prepares validation errors in question order without allocating an id", () => {
    const prepared = preparePublicFormSubmission(questions, initialPublicFormValues(questions));
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.firstInvalidQuestionId, "text");
    assert.equal(Object.keys(prepared.errors).length, 6);
  });

  test("reuses an idempotency id on retry and snapshots array answers", () => {
    const values: Record<string, string[]> = { multi: ["sales"] };
    const submissionId = "00000000-0000-4000-8000-000000000099";
    const prepared = preparePublicFormSubmission(
      [question("multi", "multiselect", { required: true })],
      values,
      submissionId,
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.body.submissionId, submissionId);
    values.multi.push("support");
    assert.deepEqual(prepared.body.values, { multi: ["sales"] });
  });

  test("creates a valid idempotency id for a new valid response", () => {
    const prepared = preparePublicFormSubmission([question("name", "text")], { name: "Ada" });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.match(prepared.body.submissionId, UUID_V4_PATTERN);
    assert.deepEqual(prepared.body.values, { name: "Ada" });
  });
});
