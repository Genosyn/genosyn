import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { z, type ZodTypeAny } from "zod";

import "./registry.js";
import {
  convertZodSchemas,
  fallbackSchema,
  isOptionalSchema,
  objectShapeOf,
  unwrapOnce,
  type JsonSchema,
} from "./schemaConversion.js";

/**
 * Route schemas reach the API reference through zod-to-openapi when it can
 * convert them and through the fallback when it cannot. These tests pin both:
 * what the library produces for the shapes routes use, and that every kind of
 * schema it refuses still yields a usable description instead of an error.
 */

const convertOne = (schema: ZodTypeAny) => {
  const result = convertZodSchemas([schema]);
  return {
    schema: result.converted.get(schema) as JsonSchema,
    fellBack: result.fallbacks.includes(schema),
  };
};

type Treeish = {
  type?: string;
  properties?: Record<string, Treeish>;
  items?: Treeish;
  required?: string[];
  [key: string]: unknown;
};

describe("zod-to-openapi converts the shapes routes validate with", () => {
  test("objects, strings, numbers, enums and optional fields", () => {
    const { schema, fellBack } = convertOne(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          email: z.string().email(),
          count: z.number().int().min(0),
          kind: z.enum(["a", "b"]),
          note: z.string().optional(),
          archived: z.boolean().default(false),
        })
        .strict(),
    );
    const tree = schema as Treeish;
    assert.equal(fellBack, false);
    assert.equal(tree.type, "object");
    assert.equal(tree.additionalProperties, false);
    assert.deepEqual(tree.required, ["name", "email", "count", "kind"]);
    assert.equal(tree.properties?.name.maxLength, 200);
    assert.equal(tree.properties?.email.format, "email");
    assert.equal(tree.properties?.count.type, "integer");
    assert.deepEqual(tree.properties?.kind.enum, ["a", "b"]);
    assert.equal(tree.properties?.archived.default, false);
  });

  test("transforms, refinements, preprocessing and pipelines document the input a client sends", () => {
    for (const schema of [
      z.object({ a: z.string() }).transform((value) => value.a.length),
      z.object({ a: z.string() }).refine((value) => value.a !== "x", "not x"),
      z.object({ a: z.string() }).superRefine(() => undefined),
      z.preprocess((value) => value, z.object({ a: z.string() })),
      z.object({ a: z.string() }).pipe(z.object({ a: z.string() })),
    ]) {
      const { schema: converted, fellBack } = convertOne(schema);
      assert.equal(fellBack, false);
      assert.equal((converted as Treeish).properties?.a.type, "string");
    }
  });

  test("unions, discriminated unions, records, arrays and nullables", () => {
    const { schema, fellBack } = convertOne(
      z.object({
        either: z.union([z.string(), z.number()]),
        action: z.discriminatedUnion("type", [
          z.object({ type: z.literal("one"), value: z.string() }),
          z.object({ type: z.literal("two"), count: z.number() }),
        ]),
        tags: z.array(z.string()).max(20),
        meta: z.record(z.string()),
        maybe: z.string().nullable(),
      }),
    );
    assert.equal(fellBack, false);
    const tree = schema as Treeish;
    assert.equal(tree.properties?.tags.type, "array");
    assert.equal(tree.properties?.tags.maxItems, 20);
    assert.equal(tree.properties?.maybe.nullable, true);
    assert.ok(Array.isArray((tree.properties?.action as { oneOf?: unknown[] }).oneOf));
  });

  test("named schemas come back as components the converted schema refers to", () => {
    const Named = z.object({ id: z.string() }).openapi("ConversionTestNamed");
    const wrapper = z.object({ item: Named });
    const result = convertZodSchemas([wrapper]);
    const item = (result.converted.get(wrapper) as Treeish).properties?.item;
    assert.deepEqual(item, { $ref: "#/components/schemas/ConversionTestNamed" });
    assert.ok(result.components.ConversionTestNamed);
  });
});

describe("schemas zod-to-openapi refuses still convert", () => {
  type Node = { name: string; schema: ZodTypeAny; check: (json: JsonSchema) => void };
  interface Tree {
    name: string;
    children?: Tree[];
  }
  const tree: z.ZodType<Tree> = z.lazy(() =>
    z.object({ name: z.string(), children: z.array(tree).optional() }),
  );
  const refused: Node[] = [
    {
      name: "z.lazy (a recursive tree)",
      schema: tree,
      check: (json) => {
        const node = json as Treeish;
        assert.equal(node.type, "object");
        assert.equal(node.properties?.name.type, "string");
        assert.equal(node.properties?.children?.type, "array");
      },
    },
    {
      name: "z.catch",
      schema: z.string().catch("fallback"),
      check: (json) => assert.equal(json.type, "string"),
    },
    {
      name: "z.map",
      schema: z.map(z.string(), z.number()),
      check: (json) => {
        assert.equal(json.type, "object");
        assert.equal((json.additionalProperties as Treeish).type, "number");
      },
    },
    {
      name: "z.set",
      schema: z.set(z.string()),
      check: (json) => {
        assert.equal(json.type, "array");
        assert.equal(json.uniqueItems, true);
      },
    },
    {
      name: "z.function",
      schema: z.function(),
      check: (json) => assert.equal(json.description, "Any value."),
    },
    {
      name: "z.promise",
      schema: z.promise(z.string()),
      check: (json) => assert.equal(json.type, "string"),
    },
    {
      name: "z.symbol",
      schema: z.symbol(),
      check: (json) => assert.equal(json.description, "Any value."),
    },
    {
      name: "z.undefined",
      schema: z.undefined(),
      check: (json) => assert.equal(json.description, "Any value."),
    },
    {
      name: "z.void",
      schema: z.void(),
      check: (json) => assert.equal(json.description, "Any value."),
    },
    {
      name: "z.nan",
      schema: z.nan(),
      check: (json) => assert.equal(json.description, "Any value."),
    },
  ];

  for (const { name, schema, check } of refused) {
    test(name, () => {
      const { schema: converted, fellBack } = convertOne(schema);
      assert.equal(fellBack, true, `${name} should need the fallback`);
      check(converted);
    });
  }

  test("one refused field does not cost the rest of the object its description", () => {
    const schema = z.object({
      title: z.string().max(80),
      when: z.date(),
      stamp: z.string().catch(""),
      seen: z.set(z.string()).optional(),
    });
    const { schema: converted, fellBack } = convertOne(schema);
    assert.equal(fellBack, true);
    const tree = converted as Treeish;
    assert.equal(tree.properties?.title.maxLength, 80);
    assert.equal(tree.properties?.when.format, "date-time");
    assert.equal(tree.properties?.stamp.type, "string");
    // `.catch()` accepts a missing value, so zod — and the reference — call it optional.
    assert.deepEqual(tree.required, ["title", "when"]);
  });

  test("a batch keeps the library's output for every schema it can convert", () => {
    const good = z.object({ ok: z.string() });
    const alsoGood = z.object({ fine: z.number() });
    const bad = z.object({ broken: z.symbol() });
    const result = convertZodSchemas([good, bad, alsoGood]);
    assert.deepEqual(result.fallbacks, [bad]);
    assert.equal((result.converted.get(good) as Treeish).properties?.ok.type, "string");
    assert.equal((result.converted.get(alsoGood) as Treeish).properties?.fine.type, "number");
    assert.equal(result.converted.size, 3);
  });

  test("duplicates are converted once", () => {
    const schema = z.object({ a: z.string() });
    const result = convertZodSchemas([schema, schema, schema]);
    assert.equal(result.converted.size, 1);
  });

  test("an empty batch is fine", () => {
    const result = convertZodSchemas([]);
    assert.equal(result.converted.size, 0);
    assert.deepEqual(result.fallbacks, []);
  });
});

describe("the fallback converter", () => {
  test("describes strings with their checks", () => {
    assert.deepEqual(fallbackSchema(z.string().min(2).max(9)), {
      type: "string",
      minLength: 2,
      maxLength: 9,
    });
    assert.equal(fallbackSchema(z.string().uuid()).format, "uuid");
    assert.equal(fallbackSchema(z.string().url()).format, "uri");
    assert.equal(fallbackSchema(z.string().datetime()).format, "date-time");
    assert.equal(fallbackSchema(z.string().regex(/^a+$/)).pattern, "^a+$");
    assert.equal(fallbackSchema(z.string().length(4)).maxLength, 4);
  });

  test("describes numbers, booleans, dates, literals and enums", () => {
    assert.deepEqual(fallbackSchema(z.number().int().min(1).max(5)), {
      type: "integer",
      minimum: 1,
      maximum: 5,
    });
    assert.equal(fallbackSchema(z.number().gt(0)).exclusiveMinimum, true);
    assert.deepEqual(fallbackSchema(z.boolean()), { type: "boolean" });
    assert.deepEqual(fallbackSchema(z.date()), { type: "string", format: "date-time" });
    assert.deepEqual(fallbackSchema(z.literal("x")), { type: "string", enum: ["x"] });
    assert.deepEqual(fallbackSchema(z.literal(null)), { nullable: true, enum: [null] });
    assert.deepEqual(fallbackSchema(z.enum(["a", "b"])), { type: "string", enum: ["a", "b"] });
    enum Color {
      Red = "red",
      Blue = "blue",
    }
    assert.deepEqual(fallbackSchema(z.nativeEnum(Color)), {
      type: "string",
      enum: ["red", "blue"],
    });
    enum Level {
      Low,
      High,
    }
    assert.deepEqual(fallbackSchema(z.nativeEnum(Level)), { type: "number", enum: [0, 1] });
    assert.deepEqual(fallbackSchema(z.bigint()), { type: "string", pattern: "^-?\\d+$" });
  });

  test("describes objects: required fields, strictness and catch-alls", () => {
    const strict = fallbackSchema(
      z.object({ a: z.string(), b: z.number().optional() }).strict(),
    ) as Treeish;
    assert.deepEqual(strict.required, ["a"]);
    assert.equal(strict.additionalProperties, false);
    const catchall = fallbackSchema(z.object({}).catchall(z.number())) as Treeish;
    assert.equal((catchall.additionalProperties as Treeish).type, "number");
    const passthrough = fallbackSchema(z.object({ a: z.string() }).passthrough()) as Treeish;
    assert.equal(passthrough.additionalProperties, undefined);
  });

  test("describes arrays, tuples, unions, intersections and wrappers", () => {
    assert.deepEqual(fallbackSchema(z.array(z.string()).min(1).max(3)), {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });
    const tuple = fallbackSchema(z.tuple([z.string(), z.number()]));
    assert.equal(tuple.minItems, 2);
    assert.equal(tuple.maxItems, 2);
    assert.equal((fallbackSchema(z.union([z.string(), z.number()])).anyOf as unknown[]).length, 2);
    assert.equal(
      (
        fallbackSchema(
          z.discriminatedUnion("t", [
            z.object({ t: z.literal("a") }),
            z.object({ t: z.literal("b") }),
          ]),
        ).anyOf as unknown[]
      ).length,
      2,
    );
    assert.equal(
      (
        fallbackSchema(z.object({ a: z.string() }).and(z.object({ b: z.string() })))
          .allOf as unknown[]
      ).length,
      2,
    );
    assert.deepEqual(fallbackSchema(z.string().nullable()), { type: "string", nullable: true });
    assert.deepEqual(fallbackSchema(z.string().default("x")), { type: "string", default: "x" });
    assert.deepEqual(fallbackSchema(z.string().optional()), { type: "string" });
    assert.deepEqual(fallbackSchema(z.string().brand<"Id">()), { type: "string" });
    assert.deepEqual(fallbackSchema(z.string().readonly()), { type: "string" });
    assert.deepEqual(fallbackSchema(z.never()), { not: {} });
    assert.deepEqual(fallbackSchema(z.any()), {});
    assert.deepEqual(fallbackSchema(z.unknown()), {});
  });

  test("keeps descriptions written with .describe()", () => {
    assert.equal(fallbackSchema(z.string().describe("The name.")).description, "The name.");
  });

  test("stops at a recursion and at absurd depth instead of looping", () => {
    interface Node {
      next?: Node;
    }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ next: node.optional() }));
    const json = fallbackSchema(node) as Treeish;
    assert.equal(json.type, "object");
    let deep: ZodTypeAny = z.string();
    for (let i = 0; i < 40; i++) deep = z.array(deep);
    assert.doesNotThrow(() => fallbackSchema(deep));
  });
});

describe("schema helpers", () => {
  test("objectShapeOf reaches through wrappers to the object", () => {
    const shape = { a: z.string() };
    for (const schema of [
      z.object(shape),
      z.object(shape).optional(),
      z
        .object(shape)
        .strict()
        .transform((value) => value),
      z.object(shape).refine(() => true),
      z.object(shape).default({ a: "x" }),
      z.object(shape).pipe(z.object(shape)),
    ]) {
      assert.deepEqual(Object.keys(objectShapeOf(schema) ?? {}), ["a"]);
    }
    assert.equal(objectShapeOf(z.string()), null);
    assert.equal(objectShapeOf(z.union([z.object(shape), z.object(shape)])), null);
  });

  test("unwrapOnce peels one wrapper at a time", () => {
    const inner = z.string();
    assert.equal(unwrapOnce(inner.optional()), inner);
    assert.equal(unwrapOnce(inner.nullable()), inner);
    assert.equal(unwrapOnce(inner), null);
  });

  test("isOptionalSchema matches zod's own idea of an optional field", () => {
    assert.equal(isOptionalSchema(z.string()), false);
    assert.equal(isOptionalSchema(z.string().optional()), true);
    assert.equal(isOptionalSchema(z.string().default("x")), true);
    assert.equal(isOptionalSchema(z.string().nullable()), false);
  });
});
