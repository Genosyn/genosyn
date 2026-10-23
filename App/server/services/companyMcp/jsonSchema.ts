/**
 * OpenAPI 3.0 schemas, rewritten as the JSON Schema an MCP tool declares.
 *
 * The API reference (`server/openapi/`) describes every request in OpenAPI
 * 3.0's dialect of JSON Schema, and an MCP tool's `inputSchema` is plain JSON
 * Schema (2020-12 by default). The two mostly agree, and differ in exactly the
 * places a strict validator — or a model provider checking a tool definition —
 * trips over:
 *
 * - **`nullable: true`.** JSON Schema has a `null` type instead. A typed schema
 *   gains `"null"` in its `type` (and `null` in its `enum`); a schema with no
 *   type of its own already accepts null, except as a member of a union, where
 *   zod-to-openapi writes a bare `{ nullable: true }` to mean "or null".
 * - **`allOf: [{ $ref }, { nullable: true }]`**, zod-to-openapi's spelling of a
 *   nullable named schema, becomes "that schema, or null".
 * - **Boolean `exclusiveMinimum` / `exclusiveMaximum`** (OpenAPI 3.0 inherited
 *   them from draft 4) become the numeric bound they qualify.
 * - **`example`** becomes `examples`.
 * - **`$ref`** into `#/components/schemas` is inlined, so each tool's schema
 *   stands alone. A schema that refers back to itself stops at the second
 *   visit, with a description in place of the endless expansion.
 * - OpenAPI-only keywords (`discriminator`, `xml`, `externalDocs`, `x-…`
 *   extensions) are dropped.
 *
 * Everything else — types, formats, bounds, patterns, enums, defaults,
 * descriptions, and the structure of objects, arrays and unions — carries over
 * unchanged, so the schema still says exactly what the route's zod validator
 * enforces.
 */

export type JsonSchema = { [key: string]: unknown };

/** Keywords both dialects spell and mean the same way. */
const SHARED_KEYWORDS = new Set([
  "title",
  "description",
  "default",
  "format",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "minimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxProperties",
  "minProperties",
  "required",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

/** Keywords that only annotate: kept beside a nullable wrapper rather than inside it. */
const ANNOTATIONS = ["title", "description", "default", "deprecated", "readOnly", "writeOnly"];

/** Deeper than any schema the App defines; a guard against a malformed document. */
const MAX_DEPTH = 64;

type Context = {
  components: Record<string, unknown>;
  /** Component names being expanded on the current branch, to stop at a cycle. */
  expanding: string[];
  depth: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A deep copy of a JSON value, so a converted schema shares nothing with the document. */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** `{ nullable: true }` and nothing that constrains the value: "anything, or null". */
function isBareNullable(schema: Record<string, unknown>): boolean {
  return (
    schema.nullable === true &&
    Object.keys(schema).every((key) => key === "nullable" || ANNOTATIONS.includes(key))
  );
}

/** Whether a converted schema accepts any value at all — no type, shape or union. */
function acceptsAnything(schema: JsonSchema): boolean {
  return Object.keys(schema).every((key) => ANNOTATIONS.includes(key) || key === "examples");
}

/** The same schema, also accepting `null`. */
function withNull(schema: JsonSchema): JsonSchema {
  if (acceptsAnything(schema)) return schema;
  if (typeof schema.type === "string" && schema.const === undefined) {
    const result: JsonSchema = { ...schema, type: [schema.type, "null"] };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      result.enum = [...schema.enum, null];
    }
    return result;
  }
  if (Array.isArray(schema.type) && schema.const === undefined) {
    const result: JsonSchema = {
      ...schema,
      type: schema.type.includes("null") ? schema.type : [...schema.type, "null"],
    };
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      result.enum = [...schema.enum, null];
    }
    return result;
  }
  // A union, a const, or an untyped shape: "this, or null".
  const annotations: JsonSchema = {};
  const rest: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.includes(key)) annotations[key] = value;
    else rest[key] = value;
  }
  return { ...annotations, anyOf: [rest, { type: "null" }] };
}

function resolveRef(ref: string, context: Context, asMember: boolean): JsonSchema {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) return {};
  const name = match[1].replace(/~1/g, "/").replace(/~0/g, "~");
  if (context.expanding.includes(name)) {
    return { description: `A ${name}, nested inside itself; see the enclosing ${name}.` };
  }
  const target = context.components[name];
  if (target === undefined) return {};
  return convert(target, { ...context, expanding: [...context.expanding, name] }, asMember);
}

function convert(schema: unknown, context: Context, asMember: boolean): JsonSchema {
  if (schema === true || schema === undefined) return {};
  if (schema === false) return { not: {} };
  if (!isRecord(schema) || context.depth > MAX_DEPTH) return {};
  const inner: Context = { ...context, depth: context.depth + 1 };

  if (typeof schema.$ref === "string") {
    // OpenAPI 3.0 ignores a reference's siblings; zod-to-openapi only ever
    // writes a description beside one, which is worth keeping.
    const resolved = resolveRef(schema.$ref, inner, asMember);
    const notes: JsonSchema = {};
    for (const key of ANNOTATIONS) if (schema[key] !== undefined) notes[key] = copy(schema[key]);
    const merged = { ...resolved, ...notes };
    return schema.nullable === true ? withNull(merged) : merged;
  }

  if (isBareNullable(schema)) {
    const annotations: JsonSchema = {};
    for (const key of ANNOTATIONS)
      if (schema[key] !== undefined) annotations[key] = copy(schema[key]);
    // In a union a bare `{ nullable: true }` is how zod-to-openapi spells
    // `z.null()`; on its own it is `z.unknown()`, which null already satisfies.
    return asMember ? { ...annotations, type: "null" } : annotations;
  }

  const result: JsonSchema = {};
  if (typeof schema.type === "string") result.type = schema.type;
  else if (Array.isArray(schema.type)) result.type = copy(schema.type);
  for (const [key, value] of Object.entries(schema)) {
    if (SHARED_KEYWORDS.has(key)) result[key] = copy(value);
  }

  if (schema.example !== undefined) result.examples = [copy(schema.example)];
  else if (Array.isArray(schema.examples)) result.examples = copy(schema.examples);

  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number") {
    result.exclusiveMinimum = schema.minimum;
    delete result.minimum;
  } else if (typeof schema.exclusiveMinimum === "number") {
    result.exclusiveMinimum = schema.exclusiveMinimum;
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number") {
    result.exclusiveMaximum = schema.maximum;
    delete result.maximum;
  } else if (typeof schema.exclusiveMaximum === "number") {
    result.exclusiveMaximum = schema.exclusiveMaximum;
  }

  if (isRecord(schema.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, property] of Object.entries(schema.properties)) {
      properties[name] = convert(property, inner, false);
    }
    result.properties = properties;
  }
  if (Array.isArray(schema.items)) {
    result.prefixItems = schema.items.map((item) => convert(item, inner, false));
  } else if (schema.items !== undefined) {
    result.items = convert(schema.items, inner, false);
  }
  if (typeof schema.additionalProperties === "boolean") {
    result.additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties !== undefined) {
    result.additionalProperties = convert(schema.additionalProperties, inner, false);
  }
  if (schema.not !== undefined) result.not = convert(schema.not, inner, false);
  for (const union of ["anyOf", "oneOf"] as const) {
    const members = schema[union];
    if (Array.isArray(members))
      result[union] = members.map((member) => convert(member, inner, true));
  }

  let nullable = schema.nullable === true;
  if (Array.isArray(schema.allOf)) {
    // `allOf: [X, { nullable: true }]` is zod-to-openapi's nullable reference.
    const members = schema.allOf.filter((member) => {
      if (isRecord(member) && isBareNullable(member)) {
        nullable = true;
        return false;
      }
      return true;
    });
    const converted = members.map((member) => convert(member, inner, false));
    if (converted.length === 1) {
      // One schema left: it is the schema, with this one's own keywords on top.
      Object.assign(result, { ...converted[0], ...result });
    } else if (converted.length > 1) {
      result.allOf = converted;
    }
  }

  return nullable ? withNull(result) : result;
}

/**
 * The JSON Schema for an OpenAPI 3.0 schema, with every reference into
 * `components` (the document's `components.schemas`) inlined.
 */
export function openApiToJsonSchema(
  schema: unknown,
  components: Record<string, unknown> = {},
): JsonSchema {
  return convert(schema, { components, expanding: [], depth: 0 }, false);
}

/** Keywords that exist in OpenAPI 3.0 and not in JSON Schema. Tests assert none survive. */
export const OPENAPI_ONLY_KEYWORDS = [
  "nullable",
  "example",
  "discriminator",
  "xml",
  "externalDocs",
  "$ref",
] as const;
