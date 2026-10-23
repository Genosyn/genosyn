/**
 * The slice of JSON Schema (as OpenAPI 3.0 writes it) the CLI reads: enough
 * to follow `$ref`s, list an object's fields, coerce a flag's text into the
 * type a field wants, and describe a field in help.
 *
 * Nothing here validates a request. The server runs the same zod schemas the
 * reference was generated from and answers 400 with the exact issues, which
 * the CLI shows; a second, client-side opinion could only drift from it.
 */

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  example?: unknown;
  title?: string;
  [key: string]: unknown;
};

const MAX_DEPTH = 24;

function isSchema(value: unknown): value is JsonSchema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An OpenAPI document's `components`: schemas, responses, parameters, request bodies. */
export type Components = Record<string, Record<string, JsonSchema> | undefined>;

/** Follows `#/components/<kind>/<name>` references inside one OpenAPI document. */
export class SchemaResolver {
  constructor(private readonly components: Components = {}) {}

  /** The schema a `$ref` chain ends at (one level of the tree; children keep their refs). */
  deref(schema: JsonSchema | undefined): JsonSchema {
    let current: JsonSchema = schema ?? {};
    for (let hops = 0; current.$ref && hops < MAX_DEPTH; hops += 1) {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(current.$ref);
      const target = match
        ? this.components[match[1]]?.[decodeURIComponent(match[2])]
        : undefined;
      if (!target) return {};
      const { $ref: _ref, ...siblings } = current;
      current = { ...target, ...siblings };
    }
    return current;
  }

  /**
   * The schema with every reference inlined, for `describe --json`. A
   * recursive type stops at the depth limit with a note rather than looping.
   */
  expand(schema: JsonSchema | undefined, depth = 0, seen: string[] = []): JsonSchema {
    if (!schema) return {};
    if (depth > MAX_DEPTH) return { description: "(nested too deeply to show)" };
    if (schema.$ref) {
      if (seen.includes(schema.$ref)) return { description: `(recursive: ${schema.$ref})` };
      return this.expand(this.deref(schema), depth + 1, [...seen, schema.$ref]);
    }
    const result: JsonSchema = { ...schema };
    if (schema.properties) {
      result.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([name, child]) => [
          name,
          this.expand(child, depth + 1, seen),
        ]),
      );
    }
    if (schema.items) result.items = this.expand(schema.items, depth + 1, seen);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const list = schema[key];
      if (Array.isArray(list)) result[key] = list.map((child) => this.expand(child, depth + 1, seen));
    }
    if (isSchema(schema.additionalProperties)) {
      result.additionalProperties = this.expand(schema.additionalProperties, depth + 1, seen);
    }
    return result;
  }

  /**
   * An object schema's top-level fields. `allOf` members are merged; the
   * variants of a `oneOf`/`anyOf` contribute every field any of them has,
   * required only when every variant requires it.
   */
  objectFields(schema: JsonSchema | undefined): {
    properties: Record<string, JsonSchema>;
    required: Set<string>;
  } {
    const properties: Record<string, JsonSchema> = {};
    const required = new Set<string>();
    const visit = (input: JsonSchema | undefined, depth: number): void => {
      if (!input || depth > MAX_DEPTH) return;
      const resolved = this.deref(input);
      for (const [name, child] of Object.entries(resolved.properties ?? {})) {
        if (!(name in properties)) properties[name] = child;
      }
      for (const name of resolved.required ?? []) required.add(name);
      for (const member of resolved.allOf ?? []) visit(member, depth + 1);
      const variants = resolved.oneOf ?? resolved.anyOf;
      if (variants?.length) {
        const variantFields = variants.map((variant) => this.objectFields(this.deref(variant)));
        for (const fields of variantFields) {
          for (const [name, child] of Object.entries(fields.properties)) {
            if (!(name in properties)) properties[name] = child;
          }
        }
        const always = Object.keys(variantFields[0]?.properties ?? {}).filter((name) =>
          variantFields.every((fields) => fields.required.has(name)),
        );
        for (const name of always) required.add(name);
      }
    };
    visit(schema, 0);
    return { properties, required };
  }

  /** Every JSON type a value of this schema may have. */
  allowedTypes(schema: JsonSchema | undefined): Set<string> {
    const types = new Set<string>();
    const visit = (input: JsonSchema | undefined, depth: number): void => {
      if (!input || depth > MAX_DEPTH) return;
      const resolved = this.deref(input);
      if (Array.isArray(resolved.type)) resolved.type.forEach((type) => types.add(type));
      else if (typeof resolved.type === "string") types.add(resolved.type);
      if (resolved.nullable) types.add("null");
      if (resolved.enum) {
        for (const value of resolved.enum) {
          if (value === null) types.add("null");
          else if (typeof value === "string") types.add("string");
          else if (typeof value === "number") types.add("number");
          else if (typeof value === "boolean") types.add("boolean");
        }
      }
      if (!resolved.type && resolved.properties) types.add("object");
      if (!resolved.type && resolved.items) types.add("array");
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        for (const member of resolved[key] ?? []) visit(member, depth + 1);
      }
    };
    visit(schema, 0);
    return types;
  }

  /** Whether the schema describes uploaded bytes (`format: binary`). */
  isBinary(schema: JsonSchema | undefined): boolean {
    const resolved = this.deref(schema);
    return resolved.type === "string" && resolved.format === "binary";
  }

  /** A short type for help: `string`, `integer`, `a|b|c`, `string[]`, `file`, `object`. */
  typeLabel(schema: JsonSchema | undefined): string {
    const resolved = this.deref(schema);
    if (this.isBinary(resolved)) return "file";
    if (resolved.enum?.length) {
      const values = resolved.enum.filter((value) => value !== null).map((value) => String(value));
      const shown = values.slice(0, 6).join("|");
      return values.length > 6 ? `${shown}|…` : shown;
    }
    const types = [...this.allowedTypes(resolved)].filter((type) => type !== "null");
    if (types.includes("integer")) {
      const index = types.indexOf("number");
      if (index !== -1) types.splice(index, 1);
    }
    if (types.length === 1 && types[0] === "array") {
      const item = resolved.items ? this.typeLabel(resolved.items) : "value";
      return item.includes("|") ? `(${item})[]` : `${item}[]`;
    }
    if (types.length === 0) return "value";
    return types.join("|");
  }

  /** Limits and hints for help: `required`, `1–140 chars`, `uuid`, `default: x`. */
  constraints(schema: JsonSchema | undefined): string[] {
    const resolved = this.deref(schema);
    const notes: string[] = [];
    const range = (min: number | undefined, max: number | undefined, unit: string) => {
      if (min !== undefined && min === max) notes.push(`exactly ${min}${unit}`);
      else if (min !== undefined && max !== undefined) notes.push(`${min}–${max}${unit}`);
      else if (min !== undefined) notes.push(`at least ${min}${unit}`);
      else if (max !== undefined) notes.push(`up to ${max}${unit}`);
    };
    range(resolved.minLength, resolved.maxLength, " chars");
    const minimum =
      typeof resolved.exclusiveMinimum === "number" ? resolved.exclusiveMinimum : resolved.minimum;
    const maximum =
      typeof resolved.exclusiveMaximum === "number" ? resolved.exclusiveMaximum : resolved.maximum;
    range(minimum, maximum, "");
    range(resolved.minItems, resolved.maxItems, " items");
    if (resolved.format && resolved.format !== "binary") notes.push(resolved.format);
    if (resolved.nullable) notes.push("nullable");
    if (resolved.default !== undefined) notes.push(`default: ${JSON.stringify(resolved.default)}`);
    return notes;
  }
}
