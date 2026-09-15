import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BaseField } from "./api";
import {
  baseFormStatus,
  createClientUuid,
  publicFormUrlNotice,
  selectOptionsForField,
} from "./baseForms";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
});

describe("baseFormStatus", () => {
  test("shows an archived table's form as unavailable instead of live", () => {
    const form = { publishedAt: "2026-09-15T12:00:00.000Z", acceptingResponses: true };
    assert.deepEqual(baseFormStatus(form), { label: "Live", tone: "emerald" });
    assert.deepEqual(baseFormStatus(form, true), { label: "Unavailable", tone: "amber" });
  });
});

describe("publicFormUrlNotice", () => {
  test("always identifies localhost and loopback links as local-only", () => {
    assert.equal(publicFormUrlNotice("http://localhost:8471/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("http://127.0.0.1:8471/forms/token", true), "local-only");
    assert.equal(publicFormUrlNotice("http://[::1]:8471/forms/token", true), "local-only");
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
});
