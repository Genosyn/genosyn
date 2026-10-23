/**
 * Every way `genosyn-api` can fail, with the exit code a script can branch on.
 *
 * The codes are part of the CLI's contract — the docs and `help exit-codes`
 * list them — so a kind may be added but an existing code never changes
 * meaning. An error always reaches the person or program on stderr: one JSON
 * object when the caller is a program, a readable line or two when it is a
 * person at a terminal.
 */

export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  usage: 2,
  auth: 3,
  forbidden: 4,
  notFound: 5,
  validation: 6,
  rejected: 7,
  server: 8,
  network: 9,
} as const;

export type ErrorKind =
  | "internal"
  | "usage"
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "client_error"
  | "server"
  | "network";

const EXIT_BY_KIND: Record<ErrorKind, number> = {
  internal: EXIT_CODES.internal,
  usage: EXIT_CODES.usage,
  auth: EXIT_CODES.auth,
  forbidden: EXIT_CODES.forbidden,
  not_found: EXIT_CODES.notFound,
  validation: EXIT_CODES.validation,
  conflict: EXIT_CODES.rejected,
  rate_limited: EXIT_CODES.rejected,
  client_error: EXIT_CODES.rejected,
  server: EXIT_CODES.server,
  network: EXIT_CODES.network,
};

/** The table `help exit-codes` prints and the docs mirror. */
export const EXIT_CODE_TABLE: ReadonlyArray<{ code: number; kinds: string; meaning: string }> = [
  { code: 0, kinds: "", meaning: "Success." },
  { code: 1, kinds: "internal", meaning: "Unexpected error inside the CLI." },
  {
    code: 2,
    kinds: "usage",
    meaning: "Bad command, option or argument. Nothing was sent to the server.",
  },
  {
    code: 3,
    kinds: "auth",
    meaning: "Not logged in, or the server refused the key (401).",
  },
  {
    code: 4,
    kinds: "forbidden",
    meaning: "The key's Member may not do this (403), or it needs a signed-in browser.",
  },
  { code: 5, kinds: "not_found", meaning: "Nothing with that id in this company (404)." },
  {
    code: 6,
    kinds: "validation",
    meaning: "The server rejected the request's content (400, 422); see its issues.",
  },
  {
    code: 7,
    kinds: "conflict, rate_limited, client_error",
    meaning: "Refused for another reason: a conflict (409), too many requests (429), or other 4xx.",
  },
  { code: 8, kinds: "server", meaning: "The server failed (5xx)." },
  {
    code: 9,
    kinds: "network",
    meaning: "Could not reach the server, it timed out, redirected, or is not Genosyn.",
  },
];

/** One field the server's validation refused, mapped back to the flag that sets it. */
export type ValidationIssue = {
  path: string;
  message: string;
  flag?: string;
};

export type RequestSummary = {
  method: string;
  url: string;
  operationId?: string;
};

export type CliErrorOptions = {
  status?: number;
  hint?: string;
  issues?: ValidationIssue[];
  response?: unknown;
  request?: RequestSummary;
  cause?: unknown;
};

export class CliError extends Error {
  readonly kind: ErrorKind;
  readonly exitCode: number;
  readonly status?: number;
  readonly hint?: string;
  readonly issues?: ValidationIssue[];
  readonly response?: unknown;
  readonly request?: RequestSummary;

  constructor(kind: ErrorKind, message: string, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.kind = kind;
    this.exitCode = EXIT_BY_KIND[kind];
    this.status = options.status;
    this.hint = options.hint;
    this.issues = options.issues;
    this.response = options.response;
    this.request = options.request;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError("usage", message, { hint });
}

/**
 * A parameter the cached API description doesn't list. It may be one the
 * server added since, so the CLI refreshes the description once before it
 * reports this as a usage error.
 */
export class UnknownParameterError extends CliError {
  constructor(message: string, hint?: string) {
    super("usage", message, { hint });
    this.name = "UnknownParameterError";
  }
}

/** The error kind an HTTP status maps to. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "client_error";
}

/** The machine-readable shape of an error, as written to stderr in JSON mode. */
export function errorPayload(error: CliError): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: error.kind,
    message: error.message,
    exitCode: error.exitCode,
  };
  if (error.status !== undefined) payload.status = error.status;
  if (error.hint) payload.hint = error.hint;
  if (error.request) {
    if (error.request.operationId) payload.operationId = error.request.operationId;
    payload.method = error.request.method;
    payload.url = error.request.url;
  }
  if (error.issues?.length) payload.issues = error.issues;
  if (error.response !== undefined) payload.response = error.response;
  return { error: payload };
}

/** Wrap anything thrown into a CliError, keeping CliErrors as they are. */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("internal", `Unexpected error: ${message}`, { cause: error });
}

/**
 * The issues in a server's 400 body, `{ error: "ValidationError", issues }`,
 * flattened to a dotted path, a message and — when the operation is known —
 * the flag that sets the field.
 */
export function issuesFrom(
  body: unknown,
  flagFor?: (path: string) => string | undefined,
): ValidationIssue[] {
  if (!body || typeof body !== "object") return [];
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const result: ValidationIssue[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const rawPath = (issue as { path?: unknown }).path;
    const path = Array.isArray(rawPath)
      ? rawPath.map((part) => String(part)).join(".")
      : typeof rawPath === "string"
        ? rawPath
        : "";
    const message = String((issue as { message?: unknown }).message ?? "Invalid value");
    const flag = path && flagFor ? flagFor(path) : undefined;
    result.push(flag ? { path, message, flag } : { path, message });
  }
  return result;
}

const HUMAN_TITLES: Record<ErrorKind, string> = {
  internal: "Something went wrong",
  usage: "Usage",
  auth: "Not authorized",
  forbidden: "Forbidden",
  not_found: "Not found",
  validation: "Rejected",
  conflict: "Conflict",
  rate_limited: "Too many requests",
  client_error: "Refused",
  server: "Server error",
  network: "Network",
};

/** A person-readable rendering: a title line, the issues, and a hint. */
export function humanError(error: CliError, color: (text: string) => string): string {
  const status = error.status !== undefined ? ` (${error.status})` : "";
  const lines = [`${color("✗")} ${HUMAN_TITLES[error.kind]}${status}: ${error.message}`];
  for (const issue of error.issues ?? []) {
    const where = issue.flag ?? (issue.path || "(request)");
    lines.push(`  • ${where}: ${issue.message}`);
  }
  if (error.hint) lines.push(`  ${error.hint}`);
  return `${lines.join("\n")}\n`;
}
