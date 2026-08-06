import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  insertResourceReference,
  resourceQueryAtCaret,
  type ChatResourceReference,
} from "../../client/components/chat/resourceReferences.js";

function reference(overrides: Partial<ChatResourceReference> = {}): ChatResourceReference {
  return {
    kind: "product",
    id: "product:estimates",
    label: "Estimates",
    sublabel: "Draft and review customer quotations",
    path: "/finance/estimates",
    ...overrides,
  };
}

describe("chat resource trigger", () => {
  test("finds a # query at the caret", () => {
    assert.deepEqual(resourceQueryAtCaret("Create an #estimate", 19), {
      query: "estimate",
      start: 10,
    });
  });

  test("supports multi-word searches and a caret in the middle of a draft", () => {
    const value = "Open (#finance reports) tomorrow";
    assert.deepEqual(resourceQueryAtCaret(value, 22), {
      query: "finance reports",
      start: 6,
    });
  });

  test("does not treat @ people or an already-inserted Markdown tag as a query", () => {
    assert.equal(resourceQueryAtCaret("Ask @sam", 8), null);
    const inserted = "Open [#Estimates](/c/acme/finance/estimates)";
    assert.equal(resourceQueryAtCaret(inserted, inserted.length), null);
  });
});

describe("chat resource insertion", () => {
  test("inserts a clickable # product tag and places the caret after it", () => {
    const value = "Create an #estimate";
    const inserted = insertResourceReference({
      value,
      caret: value.length,
      start: 10,
      companySlug: "acme",
      reference: reference(),
    });
    assert.equal(inserted.value, "Create an [#Estimates](/c/acme/finance/estimates) ");
    assert.equal(inserted.caret, inserted.value.length);
  });

  test("preserves text after the caret when several things are tagged", () => {
    const value = "Create #inv then post to #team";
    const inserted = insertResourceReference({
      value,
      caret: 11,
      start: 7,
      companySlug: "acme",
      reference: reference({
        id: "product:invoices",
        label: "Invoices",
        path: "/finance/invoices",
      }),
    });
    assert.equal(inserted.value, "Create [#Invoices](/c/acme/finance/invoices) then post to #team");
  });

  test("does not double-prefix a label that already starts with #", () => {
    const inserted = insertResourceReference({
      value: "#team",
      caret: 5,
      start: 0,
      companySlug: "acme",
      reference: reference({
        kind: "channel",
        id: "channel-1",
        label: "#finance-team",
        path: "/workspace/channel-1",
      }),
    });
    assert.equal(inserted.value, "[#finance-team](/c/acme/workspace/channel-1) ");
  });

  test("escapes Markdown-significant label characters", () => {
    const inserted = insertResourceReference({
      value: "#acme",
      caret: 5,
      start: 0,
      companySlug: "acme",
      reference: reference({ label: "Acme \\ West]", path: "/customers/acme" }),
    });
    assert.equal(inserted.value, "[#Acme \\\\ West\\]](/c/acme/customers/acme) ");
  });

  test("reuses an existing space after the replaced query", () => {
    const inserted = insertResourceReference({
      value: "#estimates please",
      caret: 10,
      start: 0,
      companySlug: "acme",
      reference: reference(),
    });
    assert.equal(inserted.value, "[#Estimates](/c/acme/finance/estimates) please");
  });
});
