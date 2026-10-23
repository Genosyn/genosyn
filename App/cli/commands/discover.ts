import { suggest } from "../argv.js";
import type { Context } from "../context.js";
import { usageError } from "../errors.js";
import { accessMarker, describeOperation, operationHelp } from "../help.js";
import { sendRequest } from "../http.js";
import type { AreaInfo, Operation, OperationIndex } from "../operations.js";
import { renderTable } from "../output.js";
import { CLI_VERSION } from "../version.js";

/**
 * Finding your way around the API: `areas`, `ops`, `search`, `describe`,
 * `spec` and `version`. Everything here reads the API description; nothing
 * needs a key, so an agent can explore an install before it is trusted with
 * one.
 */

function operationRow(index: OperationIndex, operation: Operation, includeAccess: boolean) {
  return {
    operationId: operation.operationId,
    command: index.commandFor(operation),
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    area: operation.area,
    ...(includeAccess
      ? { apiKey: operation.apiKey, public: operation.public, callable: operation.callable }
      : {}),
  };
}

function printOperations(
  context: Context,
  index: OperationIndex,
  operations: Operation[],
  includeAccess: boolean,
): void {
  const rows = operations.map((operation) => operationRow(index, operation, includeAccess));
  if (context.jsonOutput || context.value("select") !== undefined || context.columns()) {
    context.result(rows);
    return;
  }
  if (rows.length === 0) {
    context.write("No operations match.\n");
    return;
  }
  context.write(
    renderTable(
      operations.map((operation) => ({
        command: index.commandFor(operation),
        method: operation.method,
        path: operation.shortPath,
        summary: `${operation.summary}${accessMarker(operation)}`,
      })),
      ["command", "method", "path", "summary"],
      context.style(),
    ),
  );
}

function findArea(index: OperationIndex, name: string): AreaInfo {
  const area = index.area(name);
  if (area) return area;
  const close = suggest(
    name,
    index.areas.map((candidate) => candidate.slug),
  );
  throw usageError(
    `No area named "${name}".`,
    close.length ? `Did you mean ${close.join(", ")}? \`genosyn-api areas\` lists them.` : "`genosyn-api areas` lists them.",
  );
}

export async function commandAreas(context: Context, words: string[]): Promise<void> {
  if (words.length) throw usageError(`Unexpected argument: ${words.join(" ")}.`);
  const index = await context.index();
  const all = context.flag("include-all");
  const areas = index.areas
    .filter((area) => all || area.apiKeyOperations > 0)
    .map((area) => ({
      area: area.slug,
      name: area.name,
      operations: all ? area.operations.length : area.apiKeyOperations,
      ...(all ? { apiKeyOperations: area.apiKeyOperations } : {}),
      description: area.description,
    }));
  if (context.jsonOutput || context.value("select") !== undefined || context.columns()) {
    context.result(areas);
    return;
  }
  context.write(
    renderTable(
      areas,
      all ? ["area", "operations", "apiKeyOperations", "description"] : ["area", "operations", "description"],
      context.style(),
    ),
  );
}

export async function commandOps(context: Context, words: string[]): Promise<void> {
  if (words.length > 1) throw usageError(`Unexpected argument: ${words.slice(1).join(" ")}.`);
  const index = await context.index();
  const all = context.flag("include-all");
  const area = words[0] ? findArea(index, words[0]) : undefined;
  const search = context.value("search");
  const operations = (
    search !== undefined
      ? index.search(search, { includeAll: all })
      : index.operations.filter((operation) => all || operation.apiKey)
  ).filter((operation) => !area || operation.area === area.name);
  printOperations(context, index, operations, all);
}

export async function commandSearch(context: Context, words: string[]): Promise<void> {
  const query = words.join(" ").trim();
  if (!query) throw usageError("search needs some text: genosyn-api search deal");
  const index = await context.index();
  const all = context.flag("include-all");
  printOperations(context, index, index.search(query, { includeAll: all }), all);
}

/** Resolve `describe`'s arguments — `<operation>` or `<area> <operation>` — refreshing once if unknown. */
export async function resolveOperationRef(
  context: Context,
  words: string[],
): Promise<{ index: OperationIndex; operation: Operation }> {
  if (words.length === 0 || words.length > 2) {
    throw usageError("Name one operation: genosyn-api describe createRevenueDeal");
  }
  const attempt = (index: OperationIndex): Operation | undefined => {
    if (words.length === 1) return index.find(words[0]);
    const area = index.area(words[0]);
    return area ? index.findInArea(area, words[1]) : undefined;
  };
  let index = await context.index();
  let operation = attempt(index);
  if (!operation && context.specFromCache()) {
    index = await context.index(true);
    operation = attempt(index);
  }
  if (!operation) {
    const candidates = index.search(words.join(" "), { includeAll: true }).slice(0, 3);
    throw usageError(
      `No operation named "${words.join(" ")}".`,
      candidates.length
        ? `Close matches: ${candidates.map((candidate) => candidate.operationId).join(", ")}. \`genosyn-api search <text>\` finds others.`
        : "`genosyn-api search <text>` finds operations.",
    );
  }
  return { index, operation };
}

export async function commandDescribe(context: Context, words: string[]): Promise<void> {
  const { index, operation } = await resolveOperationRef(context, words);
  if (context.jsonOutput || context.value("select") !== undefined) {
    context.result(describeOperation(index, operation));
    return;
  }
  context.write(operationHelp(index, operation, context.style()));
}

export async function commandSpec(context: Context, words: string[]): Promise<void> {
  const [sub = "info", ...rest] = words;
  if (rest.length) throw usageError(`Unexpected argument: ${rest.join(" ")}.`);
  if (sub === "print") {
    const spec = await context.spec();
    context.write(`${JSON.stringify(spec.document, null, context.io.stdout.isTTY ? 2 : undefined)}\n`);
    return;
  }
  if (sub !== "info" && sub !== "refresh") {
    throw usageError(`Unknown spec command "${sub}".`, "Use info, refresh or print.");
  }
  const spec = await context.spec(sub === "refresh");
  const index = await context.index();
  const info = {
    url: context.connection().baseUrl,
    serverVersion: spec.serverVersion ?? null,
    operations: index.operations.length,
    apiKeyOperations: index.operations.filter((operation) => operation.apiKey).length,
    areas: index.areas.length,
    fetchedAt: new Date(spec.fetchedAt).toISOString(),
    source: spec.source,
    cache: spec.cachePath,
  };
  context.result(info);
}

export async function commandVersion(context: Context, words: string[]): Promise<void> {
  if (words.length) throw usageError(`Unexpected argument: ${words.join(" ")}.`);
  const result: {
    cli: string;
    node: string;
    server: { url: string; version: string | null; reachable: boolean } | null;
  } = { cli: CLI_VERSION, node: process.versions.node, server: null };
  let baseUrl: string | undefined;
  try {
    baseUrl = context.connection().baseUrl;
  } catch {
    baseUrl = undefined;
  }
  if (baseUrl) {
    try {
      const response = await sendRequest(
        { method: "GET", url: `${baseUrl}/api/health`, headers: { accept: "application/json" } },
        { ...context.http(), timeoutMs: 5_000, retries: 0 },
      );
      const version = (response.json as { version?: unknown } | undefined)?.version;
      result.server = {
        url: baseUrl,
        version: typeof version === "string" ? version : null,
        reachable: response.status === 200,
      };
    } catch {
      result.server = { url: baseUrl, version: null, reachable: false };
    }
  }
  const server = result.server
    ? `\nserver       ${result.server.version ?? (result.server.reachable ? "unknown" : "unreachable")} at ${result.server.url}`
    : "";
  context.result(result, `genosyn-api  ${CLI_VERSION} (Node.js ${result.node})${server}`);
}
