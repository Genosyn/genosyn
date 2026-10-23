import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { operationCatalogue } from "./appCatalogue.js";
import {
  availabilityFor,
  CALL_TOOL_BY_KIND,
  type CallToolName,
  type CatalogueOperation,
  type OperationCatalogue,
  type OperationKind,
} from "./catalogue.js";
import { buildRequest, callArguments, sendRequest } from "./call.js";
import type { CallerContext } from "./context.js";
import type { JsonSchema } from "./jsonSchema.js";
import { callMistake, resultFor } from "./results.js";
import {
  areaOverview,
  resolveArea,
  searchOperations,
  searchWords,
  similarOperationNames,
} from "./search.js";

/**
 * The Genosyn MCP server's resident tools — the only ones `tools/list` shows.
 *
 * Hundreds of operations are too many to list at once: a client would spend
 * its context on tool definitions before the conversation began. So the
 * server lists six, and the operations stay one search away:
 *
 * - `whoami` — whose authority the key carries.
 * - `search_operations` — find operations by what you want to do, or browse an area.
 * - `describe_operation` — one operation's generated tool: inputs, access, output.
 * - `call_read_operation`, `call_write_operation`, `call_delete_operation` —
 *   call an operation by its operationId. They are split by HTTP method so
 *   each carries honest annotations: a client can let reads through and still
 *   ask a person before anything changes or is deleted.
 */

export type ResidentTool = Tool & {
  run(context: CallerContext, args: unknown, signal: AbortSignal): Promise<CallToolResult>;
};

const OPERATION_ID: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description: "The operation's id, as search_operations lists it: createRevenueDeal, listGoals.",
};

const PATH_ARGUMENT: JsonSchema = {
  type: "object",
  description:
    'Path parameters by name, such as {"id": "…"}. The company is filled in for you; leave cid out.',
  additionalProperties: { type: ["string", "number"] },
};

const QUERY_ARGUMENT: JsonSchema = {
  type: "object",
  description:
    "Query-string parameters by name. Arrays repeat the parameter; objects are sent as name[key]=value.",
  additionalProperties: true,
};

const BODY_ARGUMENT: JsonSchema = {
  description:
    "The request body, shaped as describe_operation shows. For a form, an object of its text fields.",
};

const FILE_ARGUMENT: JsonSchema = {
  type: "object",
  description:
    "The file for an operation that takes one (describe_operation names it): its name and exactly one of base64 or text.",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255, description: "contract.pdf, leads.csv" },
    contentType: {
      type: "string",
      maxLength: 255,
      description: "Guessed from the name when left out.",
    },
    base64: { type: "string", description: "The file's bytes, base64-encoded." },
    text: { type: "string", description: "A text file's contents, instead of base64." },
  },
  required: ["name"],
  additionalProperties: false,
};

const CALL_OUTPUT: NonNullable<Tool["outputSchema"]> = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    method: { type: "string" },
    path: { type: "string", description: "The concrete path the request went to." },
    status: { type: "integer", description: "The HTTP status Genosyn answered with." },
    ok: { type: "boolean" },
    contentType: { type: "string" },
    data: { description: "The answer: parsed JSON, or the text of a text response." },
    truncated: { type: "boolean", description: "Too long to return whole; ask for less." },
    bytes: { type: "integer" },
    file: {
      type: "object",
      description: "A file answer: its type and size, and where to download it.",
      properties: {
        contentType: { type: "string" },
        bytes: { type: "integer" },
        url: { type: "string" },
        name: { type: "string" },
        embedded: { type: "boolean" },
      },
    },
    error: {
      type: "object",
      properties: {
        message: { type: "string", description: "Genosyn's own message." },
        explanation: { type: "string", description: "What the status means and what to try." },
        issues: { type: "array", description: "Validation issues, each naming a field." },
      },
    },
  },
  required: ["operationId", "method", "path", "status", "ok"],
};

const KIND_LABEL: Record<OperationKind, string> = {
  read: "a read (GET)",
  write: "a write (POST, PUT or PATCH)",
  delete: "a delete (DELETE)",
};

/** The path without the prefix every company operation shares. */
const shortPath = (path: string) => path.replace(/^\/api\/companies\/\{cid\}/, "") || "/";

function zodProblems(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
}

/** An operation by name, or the tool result explaining why there is none. */
function lookUp(
  catalogue: OperationCatalogue,
  name: string,
): { operation: CatalogueOperation } | { refusal: CallToolResult } {
  const operation = catalogue.byName.get(name);
  if (operation) return { operation };
  const unavailable = catalogue.unavailable.get(name);
  if (unavailable) {
    return {
      refusal: callMistake(
        `${name} (${unavailable.method.toUpperCase()} ${unavailable.path}) cannot be called through this server. ${unavailable.reason}`,
      ),
    };
  }
  const similar = similarOperationNames(catalogue, name);
  return {
    refusal: callMistake(
      `There is no operation "${name}".` +
        (similar.length ? ` Did you mean ${similar.join(", ")}?` : "") +
        " search_operations finds operations by what they do.",
    ),
  };
}

// ── example arguments ──────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A placeholder value of a schema's shape, filling only what is required. */
export function exampleValue(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 6) return null;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null) ?? null;
  for (const union of ["anyOf", "oneOf"] as const) {
    const members = schema[union];
    if (Array.isArray(members)) {
      const first = members.find((member) => !(isRecord(member) && member.type === "null"));
      return exampleValue(first, depth + 1);
    }
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  switch (type) {
    case "string":
      switch (schema.format) {
        case "uuid":
          return "<uuid>";
        case "date-time":
          return "2026-01-31T09:00:00.000Z";
        case "date":
          return "2026-01-31";
        case "email":
          return "name@example.com";
        case "uri":
          return "https://example.com";
        default:
          return "<string>";
      }
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return typeof schema.minItems === "number" && schema.minItems > 0
        ? [exampleValue(schema.items, depth + 1)]
        : [];
    case "object":
    default: {
      if (!isRecord(schema.properties)) return type === "object" ? {} : null;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const example: Record<string, unknown> = {};
      for (const name of required) {
        example[name] = exampleValue(
          (schema.properties as Record<string, unknown>)[name],
          depth + 1,
        );
      }
      return example;
    }
  }
}

/** A call skeleton for an operation: its id and every required argument. */
function exampleCall(operation: CatalogueOperation): Record<string, unknown> {
  const properties = (operation.inputSchema.properties ?? {}) as Record<string, unknown>;
  const example: Record<string, unknown> = { operationId: operation.name };
  for (const part of ["path", "query", "body"] as const) {
    if (!properties[part]) continue;
    const value = exampleValue(properties[part]);
    if (value === null) continue;
    if (isRecord(value) && Object.keys(value).length === 0) {
      // Nothing required: only a JSON body the route insists on is worth showing empty.
      if (part === "body" && operation.body?.kind === "json" && operation.body.required) {
        example.body = {};
      }
      continue;
    }
    example[part] = value;
  }
  if (operation.upload) {
    example.file = { name: "document.pdf", base64: "<base64>" };
  }
  return example;
}

// ── the tools ──────────────────────────────────────────────────────────────

const searchArguments = z
  .object({
    query: z.string().max(200).optional(),
    area: z.string().max(100).optional(),
    kind: z.enum(["read", "write", "delete"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const describeArguments = z.object({ operationId: z.string().trim().min(1).max(120) }).strict();

const whoami: ResidentTool = {
  name: "whoami",
  title: "Who am I",
  description:
    "Whose authority this server carries: the Member whose API key it uses, their company role and Finance access, the key itself, and how many operations they can call. Call it first if you are unsure who you act as.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      user: { type: "object", description: "The key's Member." },
      company: { type: "object" },
      role: { type: "string", enum: ["owner", "admin", "member"] },
      financeAccess: { type: "string", enum: ["none", "read", "full"] },
      authentication: { type: "string" },
      apiKey: { type: ["object", "null"] },
      operations: {
        type: "object",
        properties: {
          total: { type: "integer" },
          available: { type: "integer" },
        },
      },
      endpoint: { type: "string", description: "This MCP server's URL." },
    },
    required: ["company", "role", "financeAccess"],
  },
  annotations: { title: "Who am I", readOnlyHint: true, openWorldHint: false },
  async run(context, _args, signal) {
    const catalogue = operationCatalogue(context.app);
    const me = catalogue.byName.get("getCompanyMe");
    if (!me) return callMistake("This install has no GET /api/companies/{cid}/me operation.");
    const built = buildRequest(me, { operationId: me.name }, context);
    if (!built.ok) return callMistake(built.message);
    const sent = await sendRequest(context, built.request, signal);
    const result = resultFor(me, sent, context);
    const structured = result.structuredContent as { ok?: boolean; data?: unknown } | undefined;
    if (result.isError || !structured?.ok || !isRecord(structured.data)) {
      // The call's own structured result is shaped for the call tools, not for
      // whoami's output schema, which a client would check it against.
      return { isError: true, content: result.content };
    }
    const available = catalogue.operations.filter(
      (operation) => availabilityFor(operation, context.standing).available,
    ).length;
    const whoamiData = {
      ...structured.data,
      operations: { total: catalogue.operations.length, available },
      endpoint: `${context.baseUrl}/api/companies/${context.companyId}/mcp`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(whoamiData, null, 2) }],
      structuredContent: whoamiData,
    };
  },
};

const search: ResidentTool = {
  name: "search_operations",
  title: "Search operations",
  description:
    'Find the Genosyn operation that does what you want. Every operation of Genosyn\'s REST API an API key may call is here — AI Employees and their Skills, Routines and Runs, Goals, Decisions, Tasks, Notes, Bases, Revenue, Finance, Email, Meetings, Recruiting and more. Describe the action in a few words ("create a deal", "list overdue invoices", "pause a routine"), optionally within one area. With neither query nor area it lists the areas. Each result names the call tool to use and whether the key\'s Member may call it.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 200,
        description:
          "What you want to do, in a few words. Matches operation ids, summaries, paths and areas.",
      },
      area: {
        type: "string",
        maxLength: 100,
        description:
          "Only this product area, such as Revenue or Tasks. Alone, it lists the whole area.",
      },
      kind: {
        type: "string",
        enum: ["read", "write", "delete"],
        description: "Only operations of this kind.",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many results." },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      areas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            operations: { type: "integer" },
            read: { type: "integer" },
            write: { type: "integer" },
            delete: { type: "integer" },
          },
          required: ["name", "operations"],
        },
      },
      query: { type: "string" },
      area: { type: "string" },
      kind: { type: "string" },
      total: { type: "integer" },
      offset: { type: "integer" },
      nextOffset: { type: "integer" },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            operationId: { type: "string" },
            method: { type: "string" },
            path: { type: "string" },
            summary: { type: "string" },
            area: { type: "string" },
            tool: { type: "string" },
            available: { type: "boolean" },
            unavailableReason: { type: "string" },
            note: { type: "string" },
          },
          required: ["operationId", "method", "path", "summary", "area", "tool", "available"],
        },
      },
    },
  },
  annotations: { title: "Search operations", readOnlyHint: true, openWorldHint: false },
  async run(context, args) {
    const parsed = searchArguments.safeParse(args);
    if (!parsed.success) return callMistake(`Invalid arguments: ${zodProblems(parsed.error)}`);
    const catalogue = operationCatalogue(context.app);
    // A query of nothing but filler ("the", "all") asks for nothing in particular.
    const query = searchWords(parsed.data.query ?? "").length ? parsed.data.query!.trim() : "";
    let area: string | undefined;
    if (parsed.data.area?.trim()) {
      const resolved = resolveArea(catalogue, parsed.data.area);
      if (!resolved) {
        return callMistake(
          `There is no area "${parsed.data.area}". The areas are: ${catalogue.areas.map((candidate) => candidate.name).join(", ")}.`,
        );
      }
      area = resolved;
    }

    if (!query && !area && !parsed.data.kind) {
      const areas = areaOverview(catalogue);
      const lines = areas.map(
        (entry) => `- ${entry.name} (${entry.operations}): ${entry.description}`,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              `Genosyn offers ${catalogue.operations.length} operations in ${areas.length} areas. Search with query to find one by what it does, or pass area to list an area.`,
              ...lines,
            ].join("\n"),
          },
        ],
        structuredContent: { areas, total: catalogue.operations.length },
      };
    }

    const limit = parsed.data.limit ?? 20;
    const offset = parsed.data.offset ?? 0;
    const found = searchOperations(catalogue, {
      query,
      area,
      kind: parsed.data.kind,
      limit,
      offset,
    });
    const operations = found.operations.map((operation) => {
      const availability = availabilityFor(operation, context.standing);
      return {
        operationId: operation.name,
        method: operation.method.toUpperCase(),
        path: operation.path,
        summary: operation.summary,
        area: operation.area,
        tool: operation.callTool,
        available: availability.available,
        ...(availability.available ? {} : { unavailableReason: availability.reason }),
        ...(operation.access.browserSessionRequiredTo.length
          ? {
              note: `A person at a signed-in browser is required ${operation.access.browserSessionRequiredTo.join(" and ")}.`,
            }
          : {}),
      };
    });
    const nextOffset =
      offset + operations.length < found.total ? offset + operations.length : undefined;
    const scope = [
      query ? `matching "${query}"` : "",
      area ? `in ${area}` : "",
      parsed.data.kind ? `(${parsed.data.kind} only)` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lines = operations.map(
      (operation) =>
        `- ${operation.operationId} — ${operation.method} ${shortPath(operation.path)} — ${operation.summary} [${operation.tool}]` +
        (operation.available ? "" : ` — unavailable: ${operation.unavailableReason}`),
    );
    const text = found.total
      ? [
          `${found.total} operation${found.total === 1 ? "" : "s"} ${scope}; showing ${offset + 1}–${offset + operations.length}.`,
          ...lines,
          nextOffset !== undefined ? `More: call again with offset ${nextOffset}.` : "",
          "describe_operation shows an operation's inputs before you call it.",
        ]
          .filter(Boolean)
          .join("\n")
      : `No operation ${scope}. Try other words, or leave out query to list the areas.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ...(query ? { query } : {}),
        ...(area ? { area } : {}),
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        total: found.total,
        offset,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        operations,
      },
    };
  },
};

const describe: ResidentTool = {
  name: "describe_operation",
  title: "Describe an operation",
  description:
    "Show one operation before you call it: what it does, its path, query and body inputs as JSON Schema, any file it takes, what it answers with, what access it needs, the call tool to use and an example call. Pass the operationId from search_operations.",
  inputSchema: {
    type: "object",
    properties: { operationId: OPERATION_ID },
    required: ["operationId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The operationId, which is also its generated tool name.",
      },
      title: { type: "string" },
      description: { type: "string" },
      inputSchema: { type: "object", description: "The arguments the call tool takes for it." },
      annotations: { type: "object" },
      method: { type: "string" },
      path: { type: "string" },
      area: { type: "string" },
      callWith: { type: "string", enum: Object.values(CALL_TOOL_BY_KIND) },
      available: { type: "boolean" },
      unavailableReason: { type: "string" },
      upload: { type: "object" },
      response: { type: "object" },
      example: { type: "object" },
    },
    required: ["name", "inputSchema", "method", "path", "callWith", "available"],
  },
  annotations: { title: "Describe an operation", readOnlyHint: true, openWorldHint: false },
  async run(context, args) {
    const parsed = describeArguments.safeParse(args);
    if (!parsed.success) return callMistake(`Invalid arguments: ${zodProblems(parsed.error)}`);
    const catalogue = operationCatalogue(context.app);
    const found = lookUp(catalogue, parsed.data.operationId);
    if ("refusal" in found) return found.refusal;
    const { operation } = found;
    const availability = availabilityFor(operation, context.standing);
    const described = {
      name: operation.name,
      title: operation.summary,
      description: operation.description,
      inputSchema: operation.inputSchema,
      annotations: operation.annotations,
      method: operation.method.toUpperCase(),
      path: operation.path,
      area: operation.area,
      callWith: operation.callTool,
      available: availability.available,
      ...(availability.available ? {} : { unavailableReason: availability.reason }),
      ...(operation.upload ? { upload: operation.upload } : {}),
      response: operation.response,
      example: exampleCall(operation),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(described, null, 2) }],
      structuredContent: described,
    };
  },
};

function callTool(kind: OperationKind): ResidentTool {
  const name: CallToolName = CALL_TOOL_BY_KIND[kind];
  const descriptions: Record<OperationKind, string> = {
    read: "Call a read operation (HTTP GET) by its operationId. It changes nothing. Path parameters go in path and query-string parameters in query; the company is filled in for you.",
    write:
      "Call an operation that creates, changes, sends or starts something (HTTP POST, PUT or PATCH) by its operationId, with path, query and body arguments shaped as describe_operation shows; a file goes in file. It acts with the key's Member's authority, and Genosyn records the change in its audit log under their name.",
    delete:
      "Call an operation that deletes or removes something (HTTP DELETE) by its operationId. A deletion may be permanent: be sure you have the right record, and that the person you work for wants it gone.",
  };
  const titles: Record<OperationKind, string> = {
    read: "Call a read operation",
    write: "Call a write operation",
    delete: "Call a delete operation",
  };
  const properties: Record<string, JsonSchema> = {
    operationId: OPERATION_ID,
    path: PATH_ARGUMENT,
    query: QUERY_ARGUMENT,
  };
  if (kind !== "read") properties.body = BODY_ARGUMENT;
  if (kind === "write") properties.file = FILE_ARGUMENT;
  const annotations: Record<OperationKind, Tool["annotations"]> = {
    read: { title: titles.read, readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    write: {
      title: titles.write,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    delete: {
      title: titles.delete,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  };
  return {
    name,
    title: titles[kind],
    description: descriptions[kind],
    inputSchema: {
      type: "object",
      properties,
      required: ["operationId"],
      additionalProperties: false,
    },
    outputSchema: CALL_OUTPUT,
    annotations: annotations[kind],
    async run(context, args, signal) {
      const parsed = callArguments.safeParse(args);
      if (!parsed.success) return callMistake(`Invalid arguments: ${zodProblems(parsed.error)}`);
      if (kind === "read" && (parsed.data.body !== undefined || parsed.data.file)) {
        return callMistake("A read operation takes no body or file.");
      }
      if (kind === "delete" && parsed.data.file)
        return callMistake("A delete operation takes no file.");
      const catalogue = operationCatalogue(context.app);
      const found = lookUp(catalogue, parsed.data.operationId);
      if ("refusal" in found) return found.refusal;
      const { operation } = found;
      if (operation.kind !== kind) {
        return callMistake(
          `${operation.name} is ${KIND_LABEL[operation.kind]} operation (${operation.method.toUpperCase()} ${operation.path}); call it with ${operation.callTool}, not ${name}.`,
        );
      }
      const built = buildRequest(operation, parsed.data, context);
      if (!built.ok) return callMistake(built.message);
      return resultFor(operation, await sendRequest(context, built.request, signal), context);
    },
  };
}

/** Every resident tool, in the order `tools/list` shows them. */
export const RESIDENT_TOOLS: readonly ResidentTool[] = [
  whoami,
  search,
  describe,
  callTool("read"),
  callTool("write"),
  callTool("delete"),
];

export const RESIDENT_TOOLS_BY_NAME = new Map(RESIDENT_TOOLS.map((tool) => [tool.name, tool]));

/** A resident tool as `tools/list` publishes it, without its implementation. */
export function toolDefinition(tool: ResidentTool): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}
