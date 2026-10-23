import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { openApiToJsonSchema } from "./jsonSchema.js";

/**
 * Each place OpenAPI 3.0's schema dialect and JSON Schema part ways, on the
 * shapes zod-to-openapi actually writes. `catalogue.test.ts` checks the
 * result on every operation of the real reference.
 */

describe("what carries over unchanged", () => {
  test("types, formats, bounds, patterns, enums, defaults and descriptions", () => {
    const schema = {
      type: "object",
      description: "A deal.",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, pattern: "^\\S" },
        amount: { type: "integer", minimum: 0, maximum: 100, default: 5, multipleOf: 5 },
        stage: { type: "string", enum: ["open", "won"] },
        tags: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 1,
          maxItems: 3,
        },
        meta: { type: "object", additionalProperties: { type: "string" } },
        strict: { type: "object", properties: {}, additionalProperties: false },
      },
      required: ["title"],
    };
    assert.deepEqual(openApiToJsonSchema(schema), schema);
  });

  test("unions and their members keep their shape", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["a"] } },
          required: ["kind"],
          additionalProperties: false,
        },
        { type: "object", properties: { kind: { type: "string", enum: ["b"] } } },
      ],
    };
    assert.deepEqual(openApiToJsonSchema(schema), schema);
  });

  test("the result shares nothing with the document", () => {
    const enumValues = ["a", "b"];
    const converted = openApiToJsonSchema({ type: "string", enum: enumValues });
    (converted.enum as string[]).push("c");
    assert.deepEqual(enumValues, ["a", "b"]);
  });

  test("an empty or missing schema accepts anything", () => {
    assert.deepEqual(openApiToJsonSchema({}), {});
    assert.deepEqual(openApiToJsonSchema(undefined), {});
    assert.deepEqual(openApiToJsonSchema(true), {});
    assert.deepEqual(openApiToJsonSchema(false), { not: {} });
    assert.deepEqual(openApiToJsonSchema("nonsense"), {});
  });
});

describe("nullable", () => {
  test("a typed schema gains null in its type", () => {
    assert.deepEqual(openApiToJsonSchema({ type: "string", format: "uuid", nullable: true }), {
      type: ["string", "null"],
      format: "uuid",
    });
  });

  test("an enum gains null as a value too", () => {
    assert.deepEqual(openApiToJsonSchema({ type: "string", enum: ["a", "b"], nullable: true }), {
      type: ["string", "null"],
      enum: ["a", "b", null],
    });
  });

  test("a bare { nullable: true } on its own is z.unknown(): anything", () => {
    assert.deepEqual(openApiToJsonSchema({ nullable: true }), {});
    assert.deepEqual(openApiToJsonSchema({ nullable: true, description: "Free-form." }), {
      description: "Free-form.",
    });
    assert.deepEqual(
      openApiToJsonSchema({ type: "object", additionalProperties: { nullable: true } }),
      { type: "object", additionalProperties: {} },
    );
  });

  test("a bare { nullable: true } in a union is z.null()", () => {
    assert.deepEqual(
      openApiToJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }, { nullable: true }] }),
      { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
    );
  });

  test("a nullable union or untyped shape becomes 'this, or null'", () => {
    assert.deepEqual(
      openApiToJsonSchema({
        description: "Either.",
        anyOf: [{ type: "string" }, { type: "number" }],
        nullable: true,
      }),
      {
        description: "Either.",
        anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "null" }],
      },
    );
  });

  test("an existing type list is not given null twice", () => {
    assert.deepEqual(openApiToJsonSchema({ type: ["string", "null"], nullable: true }), {
      type: ["string", "null"],
    });
  });
});

describe("references", () => {
  const components = {
    Contact: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string", format: "email" } },
      required: ["name"],
    },
    Node: {
      type: "object",
      properties: {
        label: { type: "string" },
        children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
      },
    },
  };

  test("are inlined from components", () => {
    assert.deepEqual(
      openApiToJsonSchema(
        { type: "array", items: { $ref: "#/components/schemas/Contact" } },
        components,
      ),
      { type: "array", items: components.Contact },
    );
  });

  test("keep a description written beside them", () => {
    assert.deepEqual(
      openApiToJsonSchema(
        { $ref: "#/components/schemas/Contact", description: "The buyer." },
        components,
      ),
      { ...components.Contact, description: "The buyer." },
    );
  });

  test("zod-to-openapi's nullable reference becomes 'that schema, or null'", () => {
    assert.deepEqual(
      openApiToJsonSchema(
        { allOf: [{ $ref: "#/components/schemas/Contact" }, { nullable: true }] },
        components,
      ),
      { type: ["object", "null"], properties: components.Contact.properties, required: ["name"] },
    );
  });

  test("a schema that contains itself stops at the second visit", () => {
    const converted = openApiToJsonSchema({ $ref: "#/components/schemas/Node" }, components) as {
      properties: { label: unknown; children: { type: string; items: unknown } };
    };
    assert.deepEqual(converted.properties.label, { type: "string" });
    assert.equal(converted.properties.children.type, "array");
    assert.deepEqual(converted.properties.children.items, {
      description: "A Node, nested inside itself; see the enclosing Node.",
    });
    assert.doesNotMatch(JSON.stringify(converted), /\$ref/);
  });

  test("an unknown or foreign reference accepts anything rather than failing", () => {
    assert.deepEqual(openApiToJsonSchema({ $ref: "#/components/schemas/Missing" }, components), {});
    assert.deepEqual(
      openApiToJsonSchema({ $ref: "https://example.com/schema.json" }, components),
      {},
    );
  });
});

describe("the rest of OpenAPI 3.0's dialect", () => {
  test("boolean exclusive bounds become the numeric bound they qualify", () => {
    assert.deepEqual(openApiToJsonSchema({ type: "number", minimum: 0, exclusiveMinimum: true }), {
      type: "number",
      exclusiveMinimum: 0,
    });
    assert.deepEqual(openApiToJsonSchema({ type: "number", maximum: 1, exclusiveMaximum: true }), {
      type: "number",
      exclusiveMaximum: 1,
    });
    assert.deepEqual(openApiToJsonSchema({ type: "number", minimum: 0, exclusiveMinimum: false }), {
      type: "number",
      minimum: 0,
    });
    assert.deepEqual(openApiToJsonSchema({ type: "number", exclusiveMinimum: 3 }), {
      type: "number",
      exclusiveMinimum: 3,
    });
  });

  test("example becomes examples", () => {
    assert.deepEqual(openApiToJsonSchema({ type: "string", example: "Ada" }), {
      type: "string",
      examples: ["Ada"],
    });
    assert.deepEqual(openApiToJsonSchema({ type: "string", examples: ["a", "b"] }), {
      type: "string",
      examples: ["a", "b"],
    });
  });

  test("OpenAPI-only keywords and extensions are dropped", () => {
    assert.deepEqual(
      openApiToJsonSchema({
        type: "object",
        properties: {},
        discriminator: { propertyName: "kind" },
        xml: { name: "thing" },
        externalDocs: { url: "https://example.com" },
        "x-internal": true,
      }),
      { type: "object", properties: {} },
    );
  });

  test("a one-member allOf is unwrapped onto the schema; several stay", () => {
    assert.deepEqual(openApiToJsonSchema({ allOf: [{ type: "string" }], description: "Name." }), {
      type: "string",
      description: "Name.",
    });
    assert.deepEqual(openApiToJsonSchema({ allOf: [{ type: "string" }, { minLength: 2 }] }), {
      allOf: [{ type: "string" }, { minLength: 2 }],
    });
  });

  test("a tuple's items become prefixItems", () => {
    assert.deepEqual(
      openApiToJsonSchema({ type: "array", items: [{ type: "string" }, { type: "number" }] }),
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
      },
    );
  });

  test("a document nested beyond reason is cut off rather than overflowing", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 200; depth++) schema = { type: "array", items: schema };
    const text = JSON.stringify(openApiToJsonSchema(schema));
    assert.ok(text.length < 10_000);
  });
});
