import { EXIT_CODE_TABLE } from "./errors.js";
import type { AreaInfo, Operation, OperationIndex, OperationParam } from "./operations.js";
import {
  DISCOVERY_OPTIONS,
  GLOBAL_OPTIONS,
  LOGIN_OPTIONS,
  REQUEST_OPTIONS,
  type OptionDef,
} from "./options.js";
import { paint, truncate } from "./output.js";
import { pageStyle } from "./paginate.js";

/**
 * Help, generated wherever it can be. The built-in commands' help is
 * written here; every area's and operation's comes from the API description,
 * so `--help` on an operation shipped today already lists its parameters.
 */

export const DOCS_URL = "https://genosyn.com/docs/api-cli";

type Style = { color: boolean; width: number };

function heading(text: string, style: Style): string {
  return paint("bold", text, style.color);
}

function optionRows(options: readonly OptionDef[]): Array<[string, string]> {
  return options.map((option) => {
    const names = `${option.short ? `-${option.short}, ` : "    "}--${option.name}`;
    return [option.value ? `${names} <${option.value}>` : names, option.description];
  });
}

function rows(entries: Array<[string, string]>, style: Style, indent = 2): string {
  const left = Math.min(34, Math.max(...entries.map(([name]) => name.length), 0));
  const room = Math.max(30, style.width - indent - left - 2);
  return entries
    .map(([name, text]) => {
      const pad = " ".repeat(indent);
      if (!text) return `${pad}${name}`;
      if (name.length > left) return `${pad}${name}\n${pad}${" ".repeat(left + 2)}${truncate(text, room)}`;
      return `${pad}${name.padEnd(left)}  ${truncate(text, room)}`;
    })
    .join("\n");
}

/** Prose wrapped to the terminal at word boundaries, each line indented. */
export function wrapText(text: string, width: number, indent = 2): string {
  const room = Math.max(20, width - indent);
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.replace(/\s+/g, " ").trim().split(" ")) {
        if (line && line.length + 1 + word.length > room) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) lines.push(line);
      return lines.map((value) => `${" ".repeat(indent)}${value}`).join("\n");
    })
    .join("\n\n");
}

function wrapList(items: string[], width: number, indent = 2): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (next.length + indent > width && line) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((text) => `${" ".repeat(indent)}${text}`).join("\n");
}

export function globalHelp(style: Style, index?: OperationIndex, baseUrl?: string): string {
  const sections = [
    `${heading("genosyn-api", style)} — use Genosyn's API from a terminal, a script or an AI agent.`,
    `${heading("Usage", style)}
  genosyn-api <command> [options]
  genosyn-api <area> <operation> [arguments] [options]`,
    `${heading("Get started", style)}
${rows(
  [
    ["login", "Save your install's address and an API key as a profile"],
    ["whoami", "Show the Member, role and key you are acting as"],
    ["profiles", "List profiles; `profiles use <name>` switches"],
    ["logout", "Forget a profile and its key"],
  ],
  style,
)}`,
    `${heading("Discover", style)}
${rows(
  [
    ["areas", "List the API's areas"],
    ["ops [area]", "List operations, optionally in one area"],
    ["search <text>", "Find operations by id, summary, path or area"],
    ["describe <operation>", "Show an operation's parameters, body and access"],
  ],
  style,
)}`,
    `${heading("Call", style)}
${rows(
  [
    ["call <operation> [args]", "Call any operation by its operationId"],
    ["<area> <operation> [args]", "The same, by area: genosyn-api revenue list-deals"],
  ],
  style,
)}`,
    `${heading("More", style)}
${rows(
  [
    ["spec [refresh|print]", "Show, refresh or print the cached API description"],
    ["version", "Print the CLI's version and the server's"],
    ["help [topic]", "Help for a command, or: agents, exit-codes, environment"],
  ],
  style,
)}`,
  ];
  if (index) {
    const areas = index.areas.filter((area) => area.apiKeyOperations > 0).map((area) => area.slug);
    sections.push(
      `${heading(`Areas${baseUrl ? ` on ${baseUrl}` : ""}`, style)}\n${wrapList(areas, style.width)}`,
    );
  } else {
    sections.push(
      `${heading("Areas", style)}\n  Log in, then \`genosyn-api areas\` lists them for your install.`,
    );
  }
  sections.push(`${heading("Options", style)}\n${rows(optionRows(GLOBAL_OPTIONS), style)}`);
  sections.push(
    `Run \`genosyn-api help agents\` before scripting it from an AI agent.\nDocs: ${DOCS_URL}`,
  );
  return `${sections.join("\n\n")}\n`;
}

type BuiltinHelp = { usage: string[]; summary: string; options?: readonly OptionDef[]; notes?: string[] };

const BUILTIN_HELP: Record<string, BuiltinHelp> = {
  login: {
    usage: [
      "genosyn-api login [--url <base-url>] [--profile <name>]",
      "echo \"$KEY\" | genosyn-api login --url <base-url> --with-token",
    ],
    summary:
      "Check an API key against your install and save it, with the install's address and the company, as a profile.",
    options: LOGIN_OPTIONS,
    notes: [
      "Paste the Base URL from Settings → API keys: it ends in /api/companies/<id>, so it names the company too.",
      "The key is read from a hidden prompt or, with --with-token, from stdin — never from a flag, which would land in your shell history.",
      "The profile is named after the company unless --profile names it, and becomes the current one.",
      "Profiles live in ~/.genosyn/genosyn-api.json (GENOSYN_CONFIG), readable only by you.",
    ],
  },
  logout: {
    usage: ["genosyn-api logout [--profile <name>]"],
    summary: "Remove a profile and its key from this computer.",
    notes: [
      "The key itself keeps working until it is revoked at Settings → API keys; revoke it there if it may have leaked.",
    ],
  },
  profiles: {
    usage: [
      "genosyn-api profiles [list]",
      "genosyn-api profiles use <name>",
      "genosyn-api profiles show [name]",
      "genosyn-api profiles remove <name>",
    ],
    summary: "List saved profiles, choose the current one, show one, or remove one.",
  },
  whoami: {
    usage: ["genosyn-api whoami"],
    summary:
      "Show the Member, company, role, Finance access and key this run acts as (GET /api/companies/{cid}/me).",
  },
  areas: {
    usage: ["genosyn-api areas [--include-all]"],
    summary: "List the API's areas — one per product area — with how many operations a key can call.",
    options: DISCOVERY_OPTIONS.filter((option) => option.name === "include-all"),
  },
  ops: {
    usage: ["genosyn-api ops [area] [--search <text>] [--include-all]"],
    summary: "List operations, all of them or one area's.",
    options: DISCOVERY_OPTIONS,
  },
  search: {
    usage: ["genosyn-api search <text…> [--include-all]"],
    summary: "Find operations whose id, command, summary, path or area contains every word.",
    options: DISCOVERY_OPTIONS.filter((option) => option.name === "include-all"),
  },
  describe: {
    usage: ["genosyn-api describe <operation>", "genosyn-api describe <area> <operation>"],
    summary:
      "Show an operation: method and path, who may call it, its parameters and body, and how to call it. --json adds the full schemas.",
  },
  call: {
    usage: ["genosyn-api call <operationId> [path args] [--param value | name=value]… [options]"],
    summary: "Call any operation by its operationId — the stable name to use in scripts and agents.",
    options: REQUEST_OPTIONS,
    notes: [
      "Path parameters may be given positionally, in path order.",
      "Every parameter can be written --name value, or name=value (name:=<json> for an exact JSON value).",
      "--data takes the whole body as JSON, @file.json, or - for stdin; flags add to it.",
      "A file field takes a path: genosyn-api resources upload --file ./handbook.pdf",
    ],
  },
  spec: {
    usage: ["genosyn-api spec", "genosyn-api spec refresh", "genosyn-api spec print"],
    summary:
      "Show the cached API description's version and age, download it again, or print it as JSON.",
    notes: [
      "The CLI trusts its copy for GENOSYN_SPEC_TTL seconds (300), then checks the server's version and downloads again only when it changed.",
    ],
  },
  version: {
    usage: ["genosyn-api version", "genosyn-api --version"],
    summary: "Print the CLI's version, and the server's when one is configured.",
  },
  help: {
    usage: ["genosyn-api help [command | area | operation | topic]"],
    summary: "Show help. Topics: agents, exit-codes, environment.",
  },
};

export const BUILTIN_COMMANDS = Object.keys(BUILTIN_HELP);

export function builtinHelp(command: string, style: Style): string | null {
  const help = BUILTIN_HELP[command];
  if (!help) return null;
  const parts = [
    `${heading(`genosyn-api ${command}`, style)} — ${help.summary}`,
    `${heading("Usage", style)}\n${help.usage.map((line) => `  ${line}`).join("\n")}`,
  ];
  if (help.notes?.length) parts.push(help.notes.map((note) => `  ${note}`).join("\n"));
  if (help.options?.length) {
    parts.push(`${heading("Options", style)}\n${rows(optionRows(help.options), style)}`);
  }
  parts.push(`${heading("Global options", style)}\n${rows(optionRows(GLOBAL_OPTIONS), style)}`);
  return `${parts.join("\n\n")}\n`;
}

const SESSION_ONLY_REASONS: Record<string, string> = {
  accountLevel: "it changes the account itself",
  masterAdmin: "it is instance administration for master admins",
  browserSession: "the App keeps it for a person at a signed-in browser",
};

/** Why an operation takes no key, as a clause ("it changes the account itself"); or nothing. */
export function browserOnlyReason(operation: Operation): string | undefined {
  const reason = operation.access.sessionOnly;
  return typeof reason === "string" ? SESSION_ONLY_REASONS[reason] : undefined;
}

/** What `x-genosyn-access` says, as a sentence. */
export function accessSummary(operation: Operation): string {
  const access = operation.access;
  if (operation.public) return "Public: anyone may call it; no key is sent.";
  if (!operation.apiKey) {
    const reason = browserOnlyReason(operation);
    return `Browser only: an API key can't call this${reason ? ` — ${reason}` : ""}.`;
  }
  const parts = ["API key"];
  if (access.minimumRole) parts.push(`needs the ${access.minimumRole} role or above`);
  if (access.financeAccess) parts.push(`needs ${access.financeAccess} Finance access`);
  const browserOnly = Array.isArray(access.browserSessionRequiredTo)
    ? access.browserSessionRequiredTo
    : access.browserSessionRequiredTo
      ? [access.browserSessionRequiredTo]
      : [];
  if (browserOnly.length) {
    parts.push(`a signed-in browser is needed ${browserOnly.join(" and ")}`);
  }
  return parts.join(" · ");
}

function placeholder(index: OperationIndex, param: OperationParam): string {
  if (param.file) return "<path>";
  const label = index.resolver.typeLabel(param.schema);
  return `<${label.length > 24 ? "value" : label}>`;
}

function paramUsage(index: OperationIndex, param: OperationParam): string {
  if (param.flag) return `${param.flag} ${placeholder(index, param)}`;
  return `${param.name}=${placeholder(index, param)}`;
}

/** The shortest complete invocation: path arguments and required fields. */
export function usageLine(index: OperationIndex, operation: Operation, invokedAs: string): string {
  const required = [...operation.queryParams, ...operation.bodyFields].filter((param) => param.required);
  return [
    invokedAs,
    ...operation.pathParams.map((param) => `<${param.name}>`),
    ...required.map((param) => paramUsage(index, param)),
  ].join(" ");
}

function paramRows(index: OperationIndex, params: OperationParam[]): Array<[string, string]> {
  return params.map((param) => {
    const name =
      param.location === "path"
        ? `<${param.name}>${param.flag ? `, ${param.flag} ${placeholder(index, param)}` : ""}`
        : paramUsage(index, param);
    const notes = [
      ...(param.required && param.location !== "path" ? ["required"] : []),
      ...index.resolver.constraints(param.schema),
    ];
    const description = (param.description ?? "").replace(/\s+/g, " ").trim();
    return [name, [notes.join(" · "), description].filter(Boolean).join(" — ")];
  });
}

export function operationHelp(
  index: OperationIndex,
  operation: Operation,
  style: Style,
): string {
  const grouped = `genosyn-api ${index.commandFor(operation)}`;
  const parts = [
    `${heading(grouped, style)} — ${operation.summary || operation.operationId}`,
    `  ${operation.method} ${operation.path}\n  operationId ${operation.operationId} · area ${operation.area}\n  ${accessSummary(operation)}`,
  ];
  const description = operation.description
    .split(/\n\n+/)
    .filter((paragraph) => !paragraph.startsWith("**Access.**"))
    .join("\n\n")
    .trim();
  if (description) parts.push(wrapText(description, style.width));
  parts.push(
    `${heading("Usage", style)}\n  ${usageLine(index, operation, grouped)} [options]\n  ${usageLine(index, operation, `genosyn-api call ${operation.operationId}`)} [options]`,
  );
  if (operation.pathParams.length) {
    parts.push(`${heading("Path", style)}\n${rows(paramRows(index, operation.pathParams), style)}`);
  }
  if (operation.queryParams.length) {
    parts.push(`${heading("Query", style)}\n${rows(paramRows(index, operation.queryParams), style)}`);
  }
  if (operation.body) {
    const title = `Body (${operation.body.contentType}${operation.body.required ? ", required" : ""})`;
    const fields = operation.bodyFields.length
      ? rows(paramRows(index, operation.bodyFields), style)
      : operation.body.kind === "raw"
        ? `  The raw bytes: --data @<file> or --data - for stdin.`
        : "  Pass it with --data.";
    parts.push(`${heading(title, style)}\n${fields}`);
  }
  if (operation.fileResponse) {
    parts.push(
      `${heading("Response", style)}\n  A file (${operation.fileResponse}): save it with --output <file>, or redirect stdout.`,
    );
  }
  const paging = pageStyle(operation);
  if (paging) parts.push(`  Pages by ${paging.kind}: --all fetches every page.`);
  parts.push(
    "  Any parameter can also be written name=value, or name:=<json> for an exact JSON value.\n  --data takes the whole body as JSON, @file.json, or - for stdin; flags add to it.",
  );
  parts.push(`${heading("Request options", style)}\n${rows(optionRows(REQUEST_OPTIONS), style)}`);
  return `${parts.join("\n\n")}\n`;
}

export function areaHelp(
  index: OperationIndex,
  area: AreaInfo,
  style: Style,
  includeAll = false,
): string {
  const operations = area.operations.filter((operation) => includeAll || operation.apiKey);
  const hidden = area.operations.length - operations.length;
  const listing = operations.length
    ? rows(
        operations.map((operation) => [
          operation.commandName,
          `${operation.method} ${operation.shortPath} — ${operation.summary || operation.operationId}${accessMarker(operation)}`,
        ]),
        style,
      )
    : "  Nothing here takes an API key.";
  const parts = [
    `${heading(`genosyn-api ${area.slug}`, style)} — ${area.description || area.name}`,
    `${heading("Usage", style)}\n  genosyn-api ${area.slug} <operation> [arguments] [options]\n  genosyn-api ${area.slug} <operation> --help`,
    `${heading("Operations", style)}\n${listing}`,
  ];
  if (hidden > 0) {
    parts.push(
      `  ${hidden} more ${hidden === 1 ? "doesn't" : "don't"} take a key (public, or browser only); --include-all lists ${hidden === 1 ? "it" : "them"}.`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}

/** " (public)" or " (browser only)" for an operation that doesn't take a key; "" otherwise. */
export function accessMarker(operation: Operation): string {
  if (operation.apiKey) return "";
  return operation.public ? " (public)" : " (browser only)";
}

export function exitCodesHelp(style: Style): string {
  return `${heading("Exit codes", style)}\n${rows(
    EXIT_CODE_TABLE.map(({ code, kinds, meaning }) => [
      `${code}${kinds ? `  ${kinds}` : ""}`,
      meaning,
    ]),
    style,
  )}\n\nIn JSON mode (--json, or stderr isn't a terminal) an error is one line on stderr:\n  {"error":{"kind":"not_found","message":"…","exitCode":5,"status":404,"operationId":"…","method":"GET","url":"…"}}\nA validation error adds "issues": [{"path":"title","message":"Required","flag":"--title"}].\n`;
}

export function environmentHelp(style: Style): string {
  return `${heading("Environment", style)}\n${rows(
    [
      ["GENOSYN_URL", "Install address or Base URL; over the profile's"],
      ["GENOSYN_API_KEY", "API key; over the profile's (keep it in a secret store)"],
      ["GENOSYN_COMPANY", "Company id; over the profile's"],
      ["GENOSYN_PROFILE", "Profile to use; over the current one"],
      ["GENOSYN_CONFIG", "Config file (default ~/.genosyn/genosyn-api.json)"],
      ["GENOSYN_CACHE_DIR", "Where API descriptions are cached (default beside the config)"],
      ["GENOSYN_SPEC_TTL", "Seconds to trust the cached description (default 300)"],
      ["GENOSYN_TIMEOUT", "Seconds before a request gives up (default 60)"],
      ["NO_COLOR", "Never color output"],
    ],
    style,
  )}\n\nFlags beat the environment, which beats the profile. A saved key is sent only to the install it was saved for.\n`;
}

export function agentsHelp(style: Style): string {
  return `${heading("Using genosyn-api from an AI agent", style)}

  1. Authenticate without a prompt (never print or log the key):
       export GENOSYN_URL=https://genosyn.example.com/api/companies/<company-id>
       export GENOSYN_API_KEY=gen_…
  2. Confirm who you act as before changing anything:
       genosyn-api whoami
  3. Find the operation:
       genosyn-api search "deal"
  4. Read it before calling it:
       genosyn-api describe createRevenueDeal --json
  5. Call it by operationId, which stays stable:
       genosyn-api call createRevenueDeal title="Renewal" amountCents:=120000
  6. Preview anything risky first with --dry-run.

  Output is JSON whenever stdout isn't a terminal. Errors are one JSON line on
  stderr with a stable exit code (genosyn-api help exit-codes); a 400 lists the
  fields the server refused. Lists that page take --all. Whole bodies go in
  --data '{…}', --data @file.json or --data - (stdin). An operation marked
  browser-only needs a person in the app; the CLI refuses it rather than try.
`;
}

export function topicHelp(topic: string, style: Style): string | null {
  if (topic === "exit-codes" || topic === "exit") return exitCodesHelp(style);
  if (topic === "environment" || topic === "env") return environmentHelp(style);
  if (topic === "agents" || topic === "agent") return agentsHelp(style);
  return null;
}

/** Everything about an operation, for `describe --json`. */
export function describeOperation(index: OperationIndex, operation: Operation): Record<string, unknown> {
  const responses = (index.document.paths?.[operation.path]?.[operation.method.toLowerCase()] as {
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  })?.responses;
  const success = Object.entries(responses ?? {}).find(([status]) => /^2/.test(status));
  const successContent = success ? Object.entries(success[1]?.content ?? {})[0] : undefined;
  return {
    operationId: operation.operationId,
    command: `genosyn-api ${index.commandFor(operation)}`,
    area: operation.area,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description,
    apiKey: operation.apiKey,
    public: operation.public,
    callable: operation.callable,
    access: operation.access,
    accessSummary: accessSummary(operation),
    usage: usageLine(index, operation, `genosyn-api call ${operation.operationId}`),
    parameters: index.parametersOf(operation).map((param) => ({
      name: param.name,
      in: param.location,
      ...(param.flag ? { flag: param.flag } : {}),
      item: `${param.name}=…`,
      ...(param.location === "path" ? { positional: true } : {}),
      type: index.resolver.typeLabel(param.schema),
      required: param.required,
      ...(param.file ? { file: true } : {}),
      ...(param.description ? { description: param.description } : {}),
      constraints: index.resolver.constraints(param.schema),
      schema: index.resolver.expand(param.schema),
    })),
    ...(operation.body
      ? {
          body: {
            contentType: operation.body.contentType,
            required: operation.body.required,
            schema: index.resolver.expand(operation.body.schema),
          },
        }
      : {}),
    response: successContent
      ? {
          status: Number(success?.[0]),
          contentType: successContent[0],
          schema: index.resolver.expand(successContent[1]?.schema as never),
        }
      : null,
    pagination: pageStyle(operation)?.kind ?? null,
  };
}
