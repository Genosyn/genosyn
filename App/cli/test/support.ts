import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../cli.js";
import type { CliIo } from "../io.js";
import type { OpenApiDocument } from "../operations.js";

/**
 * Doubles for driving `runCli` in-process: a terminal-or-pipe stdout and
 * stderr that remember what was written, an environment, stdin, prompts and
 * a scripted `fetch`, plus a small OpenAPI document that exercises every
 * shape the command tree reads.
 */

export type MemoryStream = {
  write(chunk: string | Uint8Array): boolean;
  isTTY: boolean;
  columns?: number;
  text(): string;
  bytes(): Buffer;
};

export function memoryStream(isTTY = false, columns = 120): MemoryStream {
  const chunks: Buffer[] = [];
  return {
    isTTY,
    columns,
    write(chunk) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => Buffer.concat(chunks),
  };
}

export type MemoryIoOptions = {
  env?: Record<string, string | undefined>;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  stdinTTY?: boolean;
  stdin?: string | Buffer;
  fetch?: typeof globalThis.fetch;
  cwd?: string;
  home?: string;
  now?: () => number;
  answers?: string[];
  secret?: string;
  columns?: number;
};

export type MemoryIo = CliIo & {
  out: MemoryStream;
  err: MemoryStream;
  prompts: string[];
  stdinReads: number;
};

/** A temporary directory removed when the test ends. */
export function tempDir(t: { after: (fn: () => void) => void }, prefix = "genosyn-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function memoryIo(options: MemoryIoOptions = {}): MemoryIo {
  const out = memoryStream(options.stdoutTTY ?? false, options.columns ?? 120);
  const err = memoryStream(options.stderrTTY ?? false, options.columns ?? 120);
  const answers = [...(options.answers ?? [])];
  const io: MemoryIo = {
    env: { ...(options.env ?? {}) },
    stdout: out,
    stderr: err,
    out,
    err,
    prompts: [],
    stdinReads: 0,
    stdinIsTTY: options.stdinTTY ?? false,
    readStdin: async () => {
      io.stdinReads += 1;
      const value = options.stdin ?? "";
      return typeof value === "string" ? Buffer.from(value) : value;
    },
    fetch:
      options.fetch ??
      (async () => {
        throw new Error("This test sends no requests");
      }),
    homedir: options.home ?? "/nonexistent-home",
    cwd: options.cwd ?? process.cwd(),
    platform: process.platform,
    now: options.now ?? (() => Date.now()),
    prompt: async (question) => {
      io.prompts.push(question);
      return answers.shift() ?? "";
    },
    promptSecret: async (question) => {
      io.prompts.push(question);
      return options.secret ?? "";
    },
  };
  return io;
}

export type RunResult = { code: number; stdout: string; stderr: string; io: MemoryIo };

/** Run the CLI in-process and collect what it wrote. */
export async function run(argv: string[], options: MemoryIoOptions = {}): Promise<RunResult> {
  const io = memoryIo(options);
  const code = await runCli(argv, io);
  return { code, stdout: io.out.text(), stderr: io.err.text(), io };
}

/** The one JSON object a run wrote to stderr in JSON mode. */
export function stderrJson(result: RunResult): { error: Record<string, unknown> } {
  const line = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return JSON.parse(line) as { error: Record<string, unknown> };
}

export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | FormData | Uint8Array | null;
};

export type FakeRoute = (request: RecordedRequest) => Response | Promise<Response>;

/** A scripted `fetch`: routes keyed "METHOD /path" (no query), every request recorded. */
export function fakeFetch(routes: Record<string, FakeRoute>): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: RecordedRequest["body"] = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof FormData) body = init.body;
    else if (init?.body instanceof Uint8Array) body = init.body;
    const request: RecordedRequest = { method: init?.method ?? "GET", url, headers, body };
    requests.push(request);
    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) return json({ error: "Not found" }, 404);
    return route(request);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
export const BASE = "https://genosyn.example.test";
export const API_KEY = "gen_TestKeyAbcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A small API description with the shapes the CLI must handle: areas in tag
 * order, path/query/body parameters, a multipart upload, a file response,
 * keyset and offset paging, a browser-only and a public operation, a
 * parameter named like a CLI option, and a `$ref`'d body.
 */
export function syntheticSpec(version = "9.9.9"): OpenApiDocument {
  const key = { apiKey: true, browserSession: true };
  const company = (name: string) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  });
  const cid = {
    name: "cid",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  };
  const ok = { 200: { description: "OK", content: { "application/json": { schema: {} } } } };
  return {
    openapi: "3.0.0",
    info: { title: "Genosyn API", version },
    tags: [
      { name: "Goals", description: "Measurable objectives." },
      { name: "Revenue", description: "Contacts and deals." },
      { name: "Resources", description: "The library." },
      { name: "API Keys", description: "Keys." },
      { name: "System", description: "Health." },
    ],
    paths: {
      "/api/companies/{cid}/goals": {
        get: {
          operationId: "listGoals",
          summary: "List goals",
          tags: ["Goals"],
          "x-genosyn-access": key,
          parameters: [cid],
          responses: ok,
        },
        post: {
          operationId: "createGoal",
          summary: "Create goal",
          tags: ["Goals"],
          "x-genosyn-access": key,
          parameters: [cid],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/GoalInput" } } },
          },
          responses: { 201: { description: "Created", content: { "application/json": { schema: {} } } } },
        },
      },
      "/api/companies/{cid}/goals/{gid}": {
        get: {
          operationId: "getGoal",
          summary: "Get goal",
          tags: ["Goals"],
          "x-genosyn-access": key,
          parameters: [cid, company("gid")],
          responses: ok,
        },
        patch: {
          operationId: "updateGoal",
          summary: "Update goal",
          tags: ["Goals"],
          "x-genosyn-access": key,
          parameters: [cid, company("gid")],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/GoalPatch" } } },
          },
          responses: ok,
        },
        delete: {
          operationId: "deleteGoal",
          summary: "Delete goal",
          tags: ["Goals"],
          "x-genosyn-access": { ...key, minimumRole: "admin" },
          parameters: [cid, company("gid")],
          responses: ok,
        },
      },
      "/api/companies/{cid}/revenue/deals": {
        get: {
          operationId: "listRevenueDeals",
          summary: "List revenue deals",
          tags: ["Revenue"],
          "x-genosyn-access": key,
          parameters: [
            cid,
            { name: "q", in: "query", required: false, schema: { type: "string" } },
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "array", items: { type: "string", enum: ["open", "won", "lost"] } },
            },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            { name: "offset", in: "query", required: false, schema: { type: "integer" } },
            {
              name: "filter",
              in: "query",
              required: false,
              style: "deepObject",
              explode: true,
              schema: { type: "object", additionalProperties: { type: "string" } },
            },
          ],
          responses: ok,
        },
      },
      "/api/companies/{cid}/revenue/deals/{id}/stage/{stageId}": {
        post: {
          operationId: "moveRevenueDealStage",
          summary: "Move deal to a stage",
          tags: ["Revenue"],
          "x-genosyn-access": key,
          parameters: [cid, company("stageId"), company("id")],
          responses: ok,
        },
      },
      "/api/companies/{cid}/revenue/follow-ups": {
        get: {
          operationId: "listRevenueFollowUps",
          summary: "List follow-ups",
          tags: ["Revenue"],
          "x-genosyn-access": key,
          parameters: [
            cid,
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          ],
          responses: ok,
        },
      },
      "/api/companies/{cid}/revenue/settings": {
        put: {
          operationId: "setRevenueSettings",
          summary: "Set revenue settings",
          tags: ["Revenue"],
          "x-genosyn-access": { ...key, financeAccess: "full" },
          parameters: [cid],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: { mode: { type: "string", enum: ["simple"] }, enabled: { type: "boolean" } },
                      required: ["mode"],
                    },
                    {
                      type: "object",
                      properties: {
                        mode: { type: "string", enum: ["advanced"] },
                        threshold: { type: "number" },
                        dryRun: { type: "boolean" },
                      },
                      required: ["mode", "threshold"],
                    },
                  ],
                },
              },
            },
          },
          responses: ok,
        },
      },
      "/api/companies/{cid}/resources": {
        post: {
          operationId: "createResource",
          summary: "Create resource",
          tags: ["Resources"],
          "x-genosyn-access": key,
          parameters: [cid],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", format: "uri" },
                    title: { type: "string", minLength: 1, maxLength: 200 },
                    tagIds: { type: "array", items: { type: "string", format: "uuid" } },
                    folderId: { type: "string", format: "uuid", nullable: true },
                    meta: { type: "object", additionalProperties: true },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: ok,
        },
      },
      "/api/companies/{cid}/resources/upload": {
        post: {
          operationId: "uploadResources",
          summary: "Upload resources",
          tags: ["Resources"],
          "x-genosyn-access": key,
          parameters: [cid],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary", description: "The file." },
                    folderId: { type: "string", format: "uuid" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: ok,
        },
      },
      "/api/companies/{cid}/resources/{slug}/file": {
        get: {
          operationId: "getResourceFile",
          summary: "Get resource file",
          tags: ["Resources"],
          "x-genosyn-access": key,
          parameters: [cid, company("slug")],
          responses: {
            200: {
              description: "The file.",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
            },
          },
        },
      },
      "/api/companies/{cid}/api-keys": {
        post: {
          operationId: "createApiKey",
          summary: "Create API key",
          tags: ["API Keys"],
          "x-genosyn-access": { apiKey: false, browserSession: true, sessionOnly: "browserSession" },
          parameters: [cid],
          responses: ok,
        },
      },
      "/api/companies/{cid}/me": {
        get: {
          operationId: "getCompanyMe",
          summary: "Who is calling",
          tags: ["Goals"],
          "x-genosyn-access": key,
          parameters: [cid],
          responses: ok,
        },
      },
      "/api/health": {
        get: {
          operationId: "getHealth",
          summary: "Get health",
          tags: ["System"],
          security: [],
          "x-genosyn-access": { apiKey: false, browserSession: false },
          responses: ok,
        },
      },
    },
    components: {
      schemas: {
        GoalInput: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 140, description: "What to achieve." },
            targetValue: { type: "number" },
            parentGoalId: { type: "string", format: "uuid", nullable: true },
            metricKind: { type: "string", enum: ["manual", "chart"] },
            archived: { type: "boolean" },
            score: { type: "integer", minimum: 0, maximum: 100 },
          },
          required: ["title", "targetValue"],
        },
        GoalPatch: {
          allOf: [
            { $ref: "#/components/schemas/GoalInput" },
            { type: "object", properties: { note: { type: "string" } } },
          ],
        },
      },
    },
  };
}

/** A fake install answering health, the spec and `/me`, plus whatever `extra` adds. */
export function fakeInstall(
  extra: Record<string, FakeRoute> = {},
  options: { version?: string; spec?: OpenApiDocument; etag?: string } = {},
) {
  const spec = options.spec ?? syntheticSpec(options.version);
  return fakeFetch({
    "GET /api/health": () => json({ ok: true, version: options.version ?? "9.9.9" }),
    "GET /api/openapi.json": (request) => {
      if (options.etag && request.headers.get("if-none-match") === options.etag) {
        return new Response(null, { status: 304 });
      }
      return json(spec, 200, options.etag ? { etag: options.etag } : {});
    },
    [`GET /api/companies/${COMPANY_ID}/me`]: (request) =>
      request.headers.get("authorization") === `Bearer ${API_KEY}`
        ? json({
            user: { id: "u1", email: "ada@example.test", name: "Ada Lovelace", handle: null },
            company: { id: COMPANY_ID, name: "Acme", slug: "acme" },
            role: "owner",
            financeAccess: "full",
            authentication: "api_key",
            apiKey: { id: "k1", name: "laptop", prefix: "gen_TestKeyA", expiresAt: null },
          })
        : json({ error: "Unauthorized" }, 401),
    ...extra,
  });
}

/**
 * Environment for a run against {@link fakeInstall} with an isolated config
 * and cache. NO_COLOR keeps terminal output plain for assertions; color has
 * its own tests.
 */
export function envFor(dir: string, extra: Record<string, string | undefined> = {}) {
  return {
    GENOSYN_CONFIG: path.join(dir, "genosyn-api.json"),
    GENOSYN_CACHE_DIR: path.join(dir, "cache"),
    NO_COLOR: "1",
    ...extra,
  };
}
