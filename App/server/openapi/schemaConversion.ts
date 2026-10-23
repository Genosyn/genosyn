import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { ZodTypeAny } from "zod";

/**
 * Turning the zod schemas routes validate with into OpenAPI.
 *
 * `@asteasolutions/zod-to-openapi` does the work wherever it can — it is what
 * the hand-written registrations use, so generated and hand-written operations
 * read the same. It cannot convert every schema a route might enforce: it has
 * no answer for `z.lazy`, `z.catch`, `z.map`, `z.set`, `z.function`,
 * `z.promise`, `z.symbol`, `z.undefined` or `z.void`, and it throws on the
 * first one it meets anywhere in a tree. A single such field must not take the
 * whole API reference down with it, so {@link convertZodSchemas} converts
 * every schema in one pass and, when that pass throws, splits the batch until
 * it has found each schema the library refuses. Those are described by
 * {@link fallbackSchema} instead — a plain converter that knows every zod
 * type, reads through transforms, refinements, preprocessing and pipelines the
 * way the library does (documenting the input a client sends), and degrades an
 * unrepresentable node to "any value" rather than failing.
 */

/** An OpenAPI 3.0 schema object, as plain JSON. */
export type JsonSchema = Record<string, unknown>;

export type SchemaConversion = {
  /** Every input schema, as OpenAPI JSON. */
  converted: Map<ZodTypeAny, JsonSchema>;
  /** Named schemas the converted ones refer to with `$ref`. */
  components: Record<string, JsonSchema>;
  /** The schemas zod-to-openapi refused, described by {@link fallbackSchema}. */
  fallbacks: ZodTypeAny[];
};

/** Convert a batch with zod-to-openapi, or throw on the first schema it refuses. */
function convertBatch(schemas: readonly ZodTypeAny[]): {
  converted: JsonSchema[];
  components: Record<string, JsonSchema>;
} {
  const document = new OpenApiGeneratorV3(
    schemas.map((schema, index) => ({
      type: "route" as const,
      route: {
        method: "post" as const,
        path: `/schema-${index}`,
        request: { body: { content: { "application/json": { schema } } } },
        responses: { 200: { description: "Converted schema" } },
      },
    })),
  ).generateDocument({ openapi: "3.0.0", info: { title: "Schema conversion", version: "0" } });
  const converted = schemas.map((_schema, index) => {
    const operation = document.paths?.[`/schema-${index}`]?.post as
      | { requestBody?: { content?: Record<string, { schema?: JsonSchema }> } }
      | undefined;
    return operation?.requestBody?.content?.["application/json"]?.schema ?? {};
  });
  return {
    converted,
    components: (document.components?.schemas ?? {}) as Record<string, JsonSchema>,
  };
}

/**
 * Convert every schema, falling back to {@link fallbackSchema} for the ones
 * zod-to-openapi cannot handle. One generator run in the common case.
 */
export function convertZodSchemas(schemas: Iterable<ZodTypeAny>): SchemaConversion {
  const unique = [...new Set(schemas)];
  const result: SchemaConversion = { converted: new Map(), components: {}, fallbacks: [] };
  const visit = (batch: ZodTypeAny[]) => {
    if (batch.length === 0) return;
    try {
      const { converted, components } = convertBatch(batch);
      batch.forEach((schema, index) => result.converted.set(schema, converted[index]));
      for (const [name, component] of Object.entries(components)) {
        result.components[name] ??= component;
      }
    } catch {
      if (batch.length === 1) {
        result.converted.set(batch[0], fallbackSchema(batch[0]));
        result.fallbacks.push(batch[0]);
        return;
      }
      const middle = Math.ceil(batch.length / 2);
      visit(batch.slice(0, middle));
      visit(batch.slice(middle));
    }
  };
  visit(unique);
  return result;
}

type ZodDef = Record<string, unknown> & { typeName?: string; description?: string };

function defOf(schema: ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/** A schema's `.describe()` text, if any. */
function describe(schema: ZodTypeAny, result: JsonSchema): JsonSchema {
  const description = (schema as unknown as { description?: string }).description;
  return description && result.description === undefined ? { ...result, description } : result;
}

/** Whether an object property may be left out. */
export function isOptionalSchema(schema: ZodTypeAny): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

/** The schema a wrapper (optional, default, effects, …) wraps, or null for a leaf. */
export function unwrapOnce(schema: ZodTypeAny): ZodTypeAny | null {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return def.innerType as ZodTypeAny;
    case "ZodEffects":
      return def.schema as ZodTypeAny;
    case "ZodPipeline":
      return def.in as ZodTypeAny;
    case "ZodBranded":
      return def.type as ZodTypeAny;
    case "ZodPromise":
      return def.type as ZodTypeAny;
    case "ZodLazy":
      return (def.getter as () => ZodTypeAny)();
    default:
      return null;
  }
}

/** Peel wrappers until a ZodObject appears, or return null when there is none. */
export function objectShapeOf(schema: ZodTypeAny): Record<string, ZodTypeAny> | null {
  let current: ZodTypeAny | null = schema;
  for (let depth = 0; current && depth < 12; depth++) {
    const def = defOf(current);
    if (def.typeName === "ZodObject") return (def.shape as () => Record<string, ZodTypeAny>)();
    current = unwrapOnce(current);
  }
  return null;
}

const MAX_DEPTH = 24;

/**
 * Describe any zod schema as an OpenAPI 3.0 schema object. Never throws: a
 * node it cannot represent becomes `{}` (any value), with a note.
 */
export function fallbackSchema(
  schema: ZodTypeAny,
  depth = 0,
  seen = new Set<unknown>(),
): JsonSchema {
  if (depth > MAX_DEPTH) return { description: "Nested deeper than this reference describes." };
  const def = defOf(schema);
  const recurse = (inner: ZodTypeAny) => fallbackSchema(inner, depth + 1, seen);

  switch (def.typeName) {
    case "ZodString": {
      const result: JsonSchema = { type: "string" };
      for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
        if (check.kind === "min") result.minLength = check.value;
        else if (check.kind === "max") result.maxLength = check.value;
        else if (check.kind === "length") result.minLength = result.maxLength = check.value;
        else if (check.kind === "email") result.format = "email";
        else if (check.kind === "url") result.format = "uri";
        else if (check.kind === "uuid") result.format = "uuid";
        else if (check.kind === "datetime") result.format = "date-time";
        else if (check.kind === "date") result.format = "date";
        else if (check.kind === "regex") result.pattern = (check.regex as RegExp).source;
      }
      return describe(schema, result);
    }
    case "ZodNumber": {
      const result: JsonSchema = { type: "number" };
      for (const check of (def.checks as Array<Record<string, unknown>>) ?? []) {
        if (check.kind === "int") result.type = "integer";
        else if (check.kind === "min") {
          result.minimum = check.value;
          if (check.inclusive === false) result.exclusiveMinimum = true;
        } else if (check.kind === "max") {
          result.maximum = check.value;
          if (check.inclusive === false) result.exclusiveMaximum = true;
        }
      }
      return describe(schema, result);
    }
    case "ZodBigInt":
      return describe(schema, { type: "string", pattern: "^-?\\d+$" });
    case "ZodBoolean":
      return describe(schema, { type: "boolean" });
    case "ZodDate":
      return describe(schema, { type: "string", format: "date-time" });
    case "ZodLiteral": {
      const value = def.value;
      const type = value === null ? undefined : typeof value;
      return describe(schema, {
        ...(type === "string" || type === "number" || type === "boolean" ? { type } : {}),
        ...(value === null ? { nullable: true } : {}),
        enum: [value],
      });
    }
    case "ZodEnum":
      return describe(schema, { type: "string", enum: [...(def.values as string[])] });
    case "ZodNativeEnum": {
      // A numeric TypeScript enum maps both ways ({ 0: "Low", Low: 0 }); keep
      // only the real members, the way zod itself reads the object.
      const members = def.values as Record<string, string | number>;
      const values = Object.keys(members)
        .filter((key) => typeof members[members[key] as string] !== "number")
        .map((key) => members[key]);
      const numeric = values.every((value) => typeof value === "number");
      return describe(schema, { type: numeric ? "number" : "string", enum: values });
    }
    case "ZodObject": {
      if (seen.has(schema)) return { description: "A recursive structure." };
      seen.add(schema);
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = recurse(value);
        if (!isOptionalSchema(value)) required.push(key);
      }
      seen.delete(schema);
      const catchall = def.catchall as ZodTypeAny | undefined;
      const catchallType = catchall ? defOf(catchall).typeName : undefined;
      const result: JsonSchema = { type: "object", properties };
      if (required.length) result.required = required;
      if (catchall && catchallType !== "ZodNever") result.additionalProperties = recurse(catchall);
      else if (def.unknownKeys === "strict") result.additionalProperties = false;
      return describe(schema, result);
    }
    case "ZodArray": {
      const result: JsonSchema = { type: "array", items: recurse(def.type as ZodTypeAny) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      const exact = def.exactLength as { value: number } | null;
      if (min) result.minItems = min.value;
      if (max) result.maxItems = max.value;
      if (exact) result.minItems = result.maxItems = exact.value;
      return describe(schema, result);
    }
    case "ZodTuple": {
      const items = (def.items as ZodTypeAny[]).map(recurse);
      return describe(schema, {
        type: "array",
        items: items.length === 1 ? items[0] : { anyOf: items },
        minItems: items.length,
        ...(def.rest ? {} : { maxItems: items.length }),
      });
    }
    case "ZodSet":
      return describe(schema, {
        type: "array",
        items: recurse(def.valueType as ZodTypeAny),
        uniqueItems: true,
      });
    case "ZodRecord":
    case "ZodMap":
      return describe(schema, {
        type: "object",
        additionalProperties: recurse(def.valueType as ZodTypeAny),
      });
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>;
      const list = Array.isArray(options) ? options : [...options.values()];
      return describe(schema, { anyOf: list.map(recurse) });
    }
    case "ZodIntersection":
      return describe(schema, {
        allOf: [recurse(def.left as ZodTypeAny), recurse(def.right as ZodTypeAny)],
      });
    case "ZodNullable":
      return describe(schema, { ...recurse(def.innerType as ZodTypeAny), nullable: true });
    case "ZodDefault": {
      let value: unknown;
      try {
        value = (def.defaultValue as () => unknown)();
      } catch {
        value = undefined;
      }
      const inner = recurse(def.innerType as ZodTypeAny);
      return describe(
        schema,
        value === undefined || typeof value === "function" ? inner : { ...inner, default: value },
      );
    }
    case "ZodOptional":
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodEffects":
    case "ZodPipeline":
    case "ZodBranded":
    case "ZodPromise":
      return describe(schema, recurse(unwrapOnce(schema) as ZodTypeAny));
    case "ZodLazy": {
      if (seen.has(schema)) return { description: "A recursive structure." };
      seen.add(schema);
      let inner: JsonSchema;
      try {
        inner = recurse((def.getter as () => ZodTypeAny)());
      } catch {
        inner = {};
      }
      seen.delete(schema);
      return describe(schema, inner);
    }
    case "ZodNull":
      return describe(schema, { nullable: true, enum: [null] });
    case "ZodNever":
      return describe(schema, { not: {} });
    case "ZodAny":
    case "ZodUnknown":
      return describe(schema, {});
    default:
      // z.undefined, z.void, z.function, z.symbol, z.nan, and anything newer.
      return describe(schema, { description: "Any value." });
  }
}
