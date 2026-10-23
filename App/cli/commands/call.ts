import fs from "node:fs";
import path from "node:path";

import { parseItem, suggest, walk, type FlagMeaning, type ItemParam, type Token } from "../argv.js";
import { requireApiKey, requireBaseUrl, requireCompany } from "../config.js";
import { optionMeaning, unknownOption, type Context } from "../context.js";
import { CliError, UnknownParameterError, usageError } from "../errors.js";
import { areaHelp, browserOnlyReason, BUILTIN_COMMANDS, builtinHelp, operationHelp } from "../help.js";
import { errorFromResponse, sendRequest, type HttpRequest } from "../http.js";
import type { Operation, OperationIndex, OperationParam } from "../operations.js";
import { findOption, GLOBAL_OPTIONS, REQUEST_OPTIONS, DISCOVERY_OPTIONS } from "../options.js";
import { collectPages, pageStyle } from "../paginate.js";
import {
  buildRequest,
  mediaTypeFor,
  paramLabel,
  withQuery,
  type DataInput,
} from "../request.js";

/**
 * Calling an operation: `call <operationId>` and `<area> <operation>`.
 *
 * Both end in {@link runOperation}, which parses the rest of the command
 * line knowing the operation's parameters, refuses what can't work before
 * sending anything (a browser-only operation, a missing path argument, a
 * file answer bound for a terminal), sends the request, and prints the
 * answer — JSON, a table, a file saved with `--output`, or the bytes as they
 * came with `--raw`.
 */

const CALL_OPTIONS = [...GLOBAL_OPTIONS, ...REQUEST_OPTIONS];

function isSwitch(index: OperationIndex, param: OperationParam): boolean {
  const types = index.resolver.allowedTypes(param.schema);
  types.delete("null");
  return types.size === 1 && types.has("boolean");
}

/**
 * A flag after the operation: the CLI's own option first, then the
 * operation's parameter. A parameter that lost its flag to an option is
 * reachable only as `name=value`, in any spelling — `--dryRun` must not slip
 * past `--dry-run` to mean the other thing.
 */
function operationMeaning(index: OperationIndex, operation: Operation) {
  return (token: Extract<Token, { type: "flag" }>): FlagMeaning => {
    const option = findOption(CALL_OPTIONS, token.name, token.short);
    if (option) return { kind: "option", option };
    if (token.short) return { kind: "unknown" };
    const param = index.findParam(operation, token.name);
    if (param) {
      if (!param.flag) {
        throw usageError(
          `--${token.name} is one of the CLI's own options' names, so ${operation.operationId}'s ${param.name} is written ${param.name}=<value>.`,
        );
      }
      return { kind: "param", takes: isSwitch(index, param) ? "switch" : "value" };
    }
    if (token.name.startsWith("no-")) {
      const base = index.findParam(operation, token.name.slice(3));
      if (base?.flag && isSwitch(index, base)) {
        return { kind: "param", takes: "negated", name: base.name };
      }
    }
    return { kind: "unknown" };
  };
}

function unknownParameter(index: OperationIndex, operation: Operation) {
  return (token: Extract<Token, { type: "flag" }>): never => {
    const labels = new Map<string, OperationParam>();
    for (const param of index.parametersOf(operation)) {
      if (param.flag) labels.set(param.flag.slice(2), param);
    }
    const options = CALL_OPTIONS.map((option) => option.name);
    const close = token.short ? [] : suggest(token.name, [...labels.keys(), ...options]);
    throw new UnknownParameterError(
      `Unknown option ${token.raw.split("=")[0]} for ${operation.operationId}.`,
      close.length
        ? `Did you mean ${close.map((name) => `--${name}`).join(", ")}? \`genosyn-api describe ${operation.operationId}\` lists every parameter.`
        : `\`genosyn-api describe ${operation.operationId}\` lists every parameter; --data takes a whole body.`,
    );
  };
}

/** `--data`: literal JSON, `@file`, or `-`/`@-` for stdin. */
export async function readData(
  context: Context,
  operation: Operation,
  raw: string | undefined,
): Promise<DataInput | undefined> {
  if (raw === undefined) return undefined;
  let bytes: Uint8Array;
  let source: string;
  if (raw === "-" || raw === "@-") {
    bytes = await context.io.readStdin();
    source = "stdin";
  } else if (raw.startsWith("@")) {
    const file = path.resolve(context.io.cwd, raw.slice(1));
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      throw usageError(`Can't read ${raw.slice(1)}: ${(error as Error).message}`);
    }
    source = file;
  } else {
    bytes = new TextEncoder().encode(raw);
    source = "--data";
  }
  if (operation.body?.kind === "raw") return { kind: "bytes", value: bytes, source };
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) throw usageError(`--data from ${source} is empty.`);
  try {
    return { kind: "json", value: JSON.parse(text), source };
  } catch (error) {
    throw usageError(
      `--data from ${source} isn't valid JSON: ${(error as Error).message}`,
      "Quote JSON for the shell: --data '{\"name\":\"Ada\"}'.",
    );
  }
}

/** The flag that sets the field a validation issue names (`title`, `items.0.name`). */
function flagForIssue(index: OperationIndex, operation: Operation, issuePath: string): string | undefined {
  const top = issuePath.split(".")[0];
  if (!top) return undefined;
  const param =
    operation.bodyFields.find((candidate) => candidate.name === top) ??
    operation.queryParams.find((candidate) => candidate.name === top) ??
    operation.pathParams.find((candidate) => candidate.name === top);
  if (!param) return undefined;
  const label = paramLabel(param);
  return issuePath === top ? label : `${label} (${issuePath})`;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-ndjson|csv)|.*\+(json|xml)$)/;

function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export async function runOperation(
  context: Context,
  index: OperationIndex,
  operation: Operation,
  rest: Token[],
): Promise<void> {
  const parsed = walk(rest, operationMeaning(index, operation), {
    onUnknown: unknownParameter(index, operation),
    into: context.options,
  });
  if (context.flag("help")) {
    context.write(operationHelp(index, operation, context.style()));
    return;
  }
  if (!operation.callable) {
    const reason = browserOnlyReason(operation);
    throw new CliError(
      "forbidden",
      `${operation.operationId} needs a person signed in to Genosyn; an API key can't call it.`,
      {
        hint: `${reason ? `${reason[0].toUpperCase()}${reason.slice(1)}. ` : ""}Do it in the app instead.`,
        request: {
          method: operation.method,
          url: operation.path,
          operationId: operation.operationId,
        },
      },
    );
  }

  const items: ItemParam[] = [];
  const positionals: string[] = [];
  for (const word of parsed.words) {
    const item = word.afterEnd ? null : parseItem(word.value);
    if (item) items.push(item);
    else positionals.push(word.value);
  }

  const connection = context.connection();
  const baseUrl = requireBaseUrl(connection);
  const companyId = operation.companyScoped ? requireCompany(connection) : undefined;
  const apiKey = operation.apiKey ? requireApiKey(connection) : undefined;
  const outputFile = context.value("output");
  const dryRun = context.flag("dry-run");
  if (
    operation.fileResponse &&
    !outputFile &&
    !context.flag("raw") &&
    !dryRun &&
    context.io.stdout.isTTY &&
    !TEXT_TYPES.test(operation.fileResponse)
  ) {
    throw usageError(
      `${operation.operationId} answers with a file (${operation.fileResponse}), which would garble the terminal.`,
      "Save it with --output <file>, or redirect stdout to one.",
    );
  }

  const built = await buildRequest({
    index,
    operation,
    flags: parsed.params,
    items,
    positionals,
    data: await readData(context, operation, context.value("data")),
    baseUrl,
    companyId,
    apiKey,
    cwd: context.io.cwd,
    openFile: (file) => fs.openAsBlob(file, { type: mediaTypeFor(file) }),
  });

  if (dryRun) {
    const preview = built.preview;
    const headers = Object.entries(preview.headers).map(([name, value]) => `${name}: ${value}`);
    const body = preview.body === undefined ? "" : `\n\n${JSON.stringify(preview.body, null, 2)}`;
    context.result(preview, `${preview.method} ${preview.url}\n${headers.join("\n")}${body}`);
    return;
  }

  const http = context.http();
  const maxPages = context.flag("all") ? context.maxPages() : 0;
  const errorContext = {
    flagFor: (issuePath: string) => flagForIssue(index, operation, issuePath),
    describeCommand: `genosyn-api describe ${operation.operationId}`,
  };
  const send = async (request: HttpRequest) => {
    const response = await sendRequest(request, http);
    if (response.status >= 400) throw errorFromResponse(response, request, errorContext);
    return response;
  };
  const response = await send(built.request);

  if (outputFile) {
    if (outputFile === "-") {
      context.write(response.bytes);
      return;
    }
    const target = path.resolve(context.io.cwd, outputFile);
    try {
      fs.writeFileSync(target, response.bytes);
    } catch (error) {
      throw usageError(`Can't write ${outputFile}: ${(error as Error).message}`);
    }
    context.result(
      {
        saved: target,
        bytes: response.bytes.byteLength,
        contentType: response.mediaType || null,
        status: response.status,
      },
      `Saved ${formatBytes(response.bytes.byteLength)}${response.mediaType ? ` (${response.mediaType})` : ""} to ${outputFile}.`,
    );
    return;
  }
  if (context.flag("raw")) {
    context.write(response.bytes);
    return;
  }
  if (!response.isJson) {
    if (response.bytes.byteLength === 0) return;
    if (TEXT_TYPES.test(response.mediaType) || response.mediaType === "") {
      const text = response.text();
      context.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    if (context.io.stdout.isTTY) {
      throw usageError(
        `The answer is a file (${response.mediaType}, ${formatBytes(response.bytes.byteLength)}); it wasn't printed.`,
        "Run it again with --output <file>.",
      );
    }
    context.write(response.bytes);
    return;
  }

  let value = response.json;
  if (context.flag("all")) {
    const paged = await collectPages({
      style: pageStyle(operation),
      first: value,
      query: built.query,
      maxPages,
      fetchPage: async (query) => (await send(withQuery(built.request, query))).json,
    });
    value = paged.value;
    if (paged.truncated) {
      context.warn(`Stopped after ${paged.pages} pages; raise --max-pages to fetch the rest.`);
    }
  }
  context.result(value);
}

/**
 * Run an operation; when it names a parameter the cached description lacks,
 * fetch the description again and retry once, since the server may have
 * added it. `relookup` finds the same operation in the refreshed tree.
 */
async function runWithRefresh(
  context: Context,
  index: OperationIndex,
  operation: Operation,
  rest: Token[],
  relookup: (fresh: OperationIndex) => Operation | undefined,
): Promise<void> {
  try {
    await runOperation(context, index, operation, rest);
  } catch (error) {
    if (!(error instanceof UnknownParameterError) || !context.specFromCache()) throw error;
    const fresh = await context.index(true);
    const again = relookup(fresh);
    if (!again) throw error;
    await runOperation(context, fresh, again, rest);
  }
}

export async function commandCall(context: Context, rest: Token[]): Promise<void> {
  const first = walk(rest, optionMeaning(CALL_OPTIONS), {
    stopAtWord: true,
    onUnknown: unknownOption(
      CALL_OPTIONS,
      "call",
      "Operation parameters go after the operation id: genosyn-api call <operationId> --name value.",
    ),
    into: context.options,
  });
  if (!first.stoppedAt) {
    if (context.flag("help")) {
      context.write(builtinHelp("call", context.style()) as string);
      return;
    }
    throw usageError(
      "call needs an operation id: genosyn-api call listRevenueDeals",
      "`genosyn-api search <text>` finds one.",
    );
  }
  let index = await context.index();
  let operation = index.find(first.stoppedAt);
  if (!operation && context.specFromCache()) {
    index = await context.index(true);
    operation = index.find(first.stoppedAt);
  }
  if (!operation) {
    const candidates = index.search(first.stoppedAt, { includeAll: true }).slice(0, 3);
    const close = candidates.length
      ? candidates.map((candidate) => candidate.operationId)
      : suggest(first.stoppedAt, index.operations.map((candidate) => candidate.operationId));
    throw usageError(
      `No operation "${first.stoppedAt}" on this server.`,
      close.length
        ? `Did you mean ${close.join(", ")}? \`genosyn-api search <text>\` finds others.`
        : "`genosyn-api search <text>` finds operations.",
    );
  }
  const id = operation.operationId;
  await runWithRefresh(context, index, operation, first.rest, (fresh) => fresh.find(id));
}

const AREA_OPTIONS = [
  ...CALL_OPTIONS,
  ...DISCOVERY_OPTIONS.filter((option) => option.name === "include-all"),
];

/** `genosyn-api <area> [operation …]`. Throws a usage error when `name` is no area either. */
export async function commandArea(context: Context, name: string, rest: Token[]): Promise<void> {
  let index = await context.index();
  let area = index.area(name);
  if (!area && context.specFromCache()) {
    index = await context.index(true);
    area = index.area(name);
  }
  if (!area) {
    const close = suggest(name, [
      ...BUILTIN_COMMANDS,
      ...index.areas.filter((candidate) => candidate.apiKeyOperations > 0).map((candidate) => candidate.slug),
    ]);
    throw usageError(
      `Unknown command "${name}".`,
      close.length
        ? `Did you mean ${close.join(", ")}? \`genosyn-api --help\` lists commands and \`genosyn-api areas\` the API's areas.`
        : "`genosyn-api --help` lists commands and `genosyn-api areas` the API's areas.",
    );
  }
  const first = walk(rest, optionMeaning(AREA_OPTIONS), {
    stopAtWord: true,
    onUnknown: unknownOption(
      AREA_OPTIONS,
      `genosyn-api ${area.slug}`,
      `Operation parameters go after the operation: genosyn-api ${area.slug} <operation> --name value.`,
    ),
    into: context.options,
  });
  if (!first.stoppedAt) {
    context.write(areaHelp(index, area, context.style(), context.flag("include-all")));
    return;
  }
  let operation = index.findInArea(area, first.stoppedAt);
  if (!operation && context.specFromCache()) {
    index = await context.index(true);
    const refreshed = index.area(name);
    operation = refreshed ? index.findInArea(refreshed, first.stoppedAt) : undefined;
  }
  if (!operation) {
    const close = suggest(
      first.stoppedAt,
      area.operations.map((candidate) => candidate.commandName),
    );
    throw usageError(
      `${area.slug} has no operation "${first.stoppedAt}".`,
      close.length
        ? `Did you mean ${close.join(", ")}? \`genosyn-api ${area.slug}\` lists them.`
        : `\`genosyn-api ${area.slug}\` lists them.`,
    );
  }
  const id = operation.operationId;
  await runWithRefresh(context, index, operation, first.rest, (fresh) => fresh.find(id));
}
