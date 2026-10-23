import { createRequire } from "node:module";

/**
 * A strict JSON Schema 2020-12 validator for tests of the schemas the Genosyn
 * MCP server publishes.
 *
 * It is the AJV the MCP SDK itself depends on (resolved from the SDK's own
 * directory, so no second copy is installed), which is what an SDK client
 * compiles a tool's schemas with — a schema this accepts is one a client
 * accepts. Strict mode turns any keyword JSON Schema does not define — an
 * OpenAPI leftover such as `nullable` or `example` — into a compile error, and
 * only the formats 2020-12 defines are known, so an OpenAPI-only format such
 * as `binary` fails too.
 */

type CompiledValidator = ((data: unknown) => boolean) & { errors?: unknown[] | null };

type Ajv2020Instance = {
  compile(schema: object): CompiledValidator;
  validateSchema(schema: object): boolean;
  addFormat(name: string, format: true): void;
  errorsText(errors?: unknown[] | null): string;
  errors?: unknown[] | null;
};

/** The formats JSON Schema 2020-12 defines. */
export const JSON_SCHEMA_FORMATS = [
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
] as const;

export function strictJsonSchemaValidator(): {
  /** Throws when the schema is not valid, strict JSON Schema 2020-12. */
  compile(schema: object): CompiledValidator;
  errorsText(errors?: unknown[] | null): string;
} {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@modelcontextprotocol/sdk/server/index.js"));
  const { default: Ajv2020 } = sdkRequire("ajv/dist/2020") as {
    default: new (options: Record<string, unknown>) => Ajv2020Instance;
  };
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: true,
    validateSchema: true,
  });
  for (const format of JSON_SCHEMA_FORMATS) ajv.addFormat(format, true);
  return {
    compile(schema: object) {
      if (!ajv.validateSchema(schema)) {
        throw new Error(`Not a JSON Schema: ${ajv.errorsText(ajv.errors)}`);
      }
      return ajv.compile(schema);
    },
    errorsText: (errors) => ajv.errorsText(errors),
  };
}
