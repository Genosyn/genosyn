import type { HttpMethod } from "./routeDiscovery.js";

/**
 * Operation ids and summaries for routes nobody wrote documentation for,
 * derived from the method and path alone.
 *
 * The ids are the names the generated tooling exposes — a CLI subcommand, an
 * MCP tool — so they are built to stay put: the same method and path always
 * produce the same id, whatever else the App registers, and nothing about a
 * route's handlers, order or file feeds into it. They read as a verb and the
 * resource it acts on, camel-cased and limited to letters and digits so every
 * consumer can use them as identifiers:
 *
 *   GET    /api/companies/{cid}/revenue/deals          listRevenueDeals
 *   POST   /api/companies/{cid}/revenue/deals          createRevenueDeal
 *   GET    /api/companies/{cid}/revenue/deals/{id}     getRevenueDeal
 *   PATCH  /api/companies/{cid}/revenue/deals/{id}     updateRevenueDeal
 *   POST   /api/companies/{cid}/revenue/deals/{id}/archive  archiveRevenueDeal
 *
 * The company prefix is dropped because every company operation shares it.
 * When two routes would still share an id, {@link assignOperationIds} keeps it
 * for the shorter path and suffixes the others with their parameters, so an
 * existing id survives a newcomer that collides with it.
 */

/**
 * Words that, as the first word of a route's last segment, name what the
 * operation does rather than what it acts on: `POST …/deals/{id}/archive` is
 * "archive deal", not "create deal archive".
 */
// prettier-ignore
const ACTION_VERBS = new Set([
  "accept", "activate", "add", "analyze", "answer", "apply", "approve", "archive", "assign",
  "attach", "authorize", "backfill", "bind", "block", "bulk", "cancel", "capture", "categorize",
  "check", "checkout", "claim", "clear", "clone", "close", "commit", "complete", "confirm",
  "connect", "convert", "copy", "deactivate", "decide", "decline", "delete", "deliver",
  "describe", "detach", "disable", "disconnect", "discard", "discover", "dismiss", "download",
  "duplicate", "enable", "enroll", "evaluate", "execute", "export", "fail", "finalize", "finish",
  "fix", "flag", "forget", "forward", "generate", "grade", "grant", "hang", "import", "inspect",
  "install", "interrupt", "invite", "issue", "join", "launch", "leave", "lift", "link", "lock",
  "login", "logout", "mark", "match", "merge", "migrate", "move", "mute", "open", "pair",
  "pause", "pay", "pin", "poll", "preview", "process", "promote", "propose", "publish", "pull",
  "purge", "push", "query", "queue", "read", "reassign", "rebuild", "recalculate", "reconcile",
  "recover", "redeem", "refresh", "regenerate", "reject", "release", "remind", "remove",
  "rename", "render", "reopen", "reorder", "repair", "replay", "reply", "request", "rerun",
  "reschedule", "reset", "resend", "resolve", "restore", "resume", "retry", "return", "reuse",
  "reveal", "review", "revise", "revoke", "rollback", "rotate", "run", "scan", "schedule",
  "screen", "search", "send", "share", "sign", "signup", "skip", "snooze", "start", "stop",
  "submit", "subscribe", "suggest", "summarize", "suspend", "sync", "test", "toggle",
  "transcribe", "transfer", "trigger", "undo", "unarchive", "unblock", "unlink", "unlock",
  "unmatch", "unmute", "unpin", "unsnooze", "unsubscribe", "upload", "validate", "verify",
  "void", "wake", "withdraw", "write",
]);

/** Verbs that also read as the action of a GET: `GET …/activities/export`. */
const GET_ACTION_VERBS = new Set(["check", "download", "export", "preview", "render", "search"]);

/** Words that turn a verb into a phrasal one: `hang-up` is one action, "hang up". */
const PARTICLES = new Set(["down", "in", "off", "out", "over", "up"]);

/** Plural-looking words that name one thing: `GET …/settings` gets settings, it does not list them. */
// prettier-ignore
const SINGULAR_PLURALS = new Set([
  "access", "address", "analytics", "business", "counts", "details", "metrics", "news",
  "preferences", "progress", "series", "settings", "species", "stats", "statistics", "status",
  "totals", "usage",
]);

/** Plurals the suffix rules get wrong. */
const IRREGULAR_PLURALS: Record<string, string> = {
  analyses: "analysis",
  children: "child",
  criteria: "criterion",
  people: "person",
};

/** Abbreviations and file types that end in "s" without being plurals. */
const NOT_PLURAL = new Set(["aws", "css", "dns", "gps", "ics", "js", "mjs", "ms", "os", "sms"]);

/** Segments that start with a verb but name a thing: a pull request is not "pull request". */
const COMPOUND_NOUNS = new Set(["pull-request", "pull-requests", "follow-up", "follow-ups"]);

/** Words cased as acronyms in summaries ("Set revenue AI access"), never in ids. */
// prettier-ignore
const ACRONYMS: Record<string, string> = {
  ai: "AI", api: "API", cac: "CAC", csv: "CSV", html: "HTML", ics: "ICS", id: "ID", js: "JS",
  json: "JSON", mcp: "MCP", mjs: "MJS", mrr: "MRR", oauth: "OAuth", pdf: "PDF", sms: "SMS",
  sso: "SSO", tldr: "TLDR", tldrs: "TLDRs", totp: "TOTP", url: "URL", vapid: "VAPID",
  webauthn: "WebAuthn", ws: "WebSocket", xlsx: "XLSX",
};

const COMPANY_SCOPE = /^\/api\/companies\/\{[^}]+\}(?=\/|$)/;

/**
 * Ids the rules would name awkwardly — `POST /api/auth/login` is not "login
 * auth" — fixed by hand. A hand-written registration's own `operationId` wins
 * over this table; the coverage test fails on an entry whose route is gone.
 */
export const OPERATION_ID_OVERRIDES: Record<string, string> = {
  "POST /api/auth/signup": "signUp",
  "POST /api/auth/login": "logIn",
  "POST /api/auth/logout": "logOut",
  "POST /api/auth/forgot": "requestPasswordReset",
  "POST /api/auth/reset": "resetPassword",
  "POST /api/auth/password": "changePassword",
  "GET /api/auth/me": "getCurrentUser",
  "PATCH /api/auth/me": "updateCurrentUser",
  "GET /api/auth/me/avatar": "getCurrentUserAvatar",
  "POST /api/auth/me/avatar": "uploadCurrentUserAvatar",
  "DELETE /api/auth/me/avatar": "deleteCurrentUserAvatar",
  "GET /api/companies/{cid}/me": "getCompanyMe",
  "GET /api/companies/{cid}/search": "searchCompany",
  "GET /api/companies/{cid}/audit": "listAuditEvents",
  "GET /api/openapi.json": "getOpenApiDocument",
  "GET /api/sign/{token}": "getSigningRequest",
  "GET /api/sign/{token}/document": "getSigningDocument",
  "POST /api/sign/{token}/view": "recordSigningView",
  "POST /api/sign/{token}/complete": "completeSigning",
  "POST /api/sign/{token}/finalize": "finalizeSigning",
  "POST /api/sign/{token}/decline": "declineSigning",
  "GET /api/sign/{token}/completed": "getCompletedSigningDocument",
  "GET /api/forms/{token}": "getPublicForm",
  "POST /api/forms/{token}/responses": "submitPublicFormResponse",
  "GET /api/careers/sites/{siteSlug}/feed.json": "getCareersSiteFeed",
};

/** Lower-cased words of one path segment: `ai-access` → [ai, access], `feed.json` → [feed, json]. */
export function segmentWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** English singular of a lower-cased noun, for the common shapes route paths use. */
export function singularize(word: string): string {
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (SINGULAR_PLURALS.has(word) || NOT_PLURAL.has(word)) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 1) return word.slice(0, -1);
  return word;
}

/** Whether a lower-cased word is a plural noun naming several things. */
export function isPlural(word: string): boolean {
  return !SINGULAR_PLURALS.has(word) && singularize(word) !== word;
}

function pascal(words: readonly string[]): string {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

export type OperationName = {
  /** What the operation does: `list`, `get`, `create`, `archive`, … */
  verb: string;
  /** What it acts on, in order: [revenue, deal]. */
  nouns: string[];
};

/**
 * The verb a route's last segment names, if it names one: `archive` → archive,
 * `hang-up` → hangUp, `bulk-delete` → bulkDelete. Only a POST (or, for a few
 * verbs, a GET) acts; `PUT …/schedule` sets a schedule rather than scheduling.
 */
function actionOf(
  method: HttpMethod,
  words: readonly string[],
): { verb: string; rest: string[] } | null {
  const [first, second, ...more] = words;
  if (!first) return null;
  const actionable =
    method === "post" ? ACTION_VERBS : method === "get" ? GET_ACTION_VERBS : new Set<string>();
  if (!actionable.has(first)) return null;
  if (second && (PARTICLES.has(second) || (first === "bulk" && ACTION_VERBS.has(second)))) {
    return { verb: `${first}${pascal([second])}`, rest: more };
  }
  return { verb: first, rest: words.slice(1) };
}

/** The verb and nouns a route's method and OpenAPI path describe. */
export function operationNameFor(method: HttpMethod, path: string): OperationName {
  // The company itself is the one resource its own prefix names.
  const scoped = COMPANY_SCOPE.test(path)
    ? `/company/{cid}${path.replace(COMPANY_SCOPE, "")}`.replace(/^\/company\/\{cid\}(?=\/.)/, "")
    : path.replace(/^\/api(?=\/|$)/, "");
  const segments = scoped.split("/").filter(Boolean);
  const isParam = (segment: string | undefined) => Boolean(segment?.startsWith("{"));
  const endsWithParam = isParam(segments[segments.length - 1]);

  let verb: string | null = null;
  let trailing: string[] = [];
  let body = segments;
  const last = segments[segments.length - 1];
  if (last && !endsWithParam && !COMPOUND_NOUNS.has(last.toLowerCase())) {
    const action = actionOf(method, segmentWords(last));
    if (action) {
      verb = action.verb;
      trailing = action.rest;
      body = segments.slice(0, -1);
    }
  }

  const nouns: string[] = [];
  body.forEach((segment, index) => {
    if (isParam(segment)) return;
    const words = segmentWords(segment);
    if (words.length === 0) return;
    if (isParam(body[index + 1])) words[words.length - 1] = singularize(words[words.length - 1]);
    nouns.push(...words);
  });
  nouns.push(...trailing);

  if (!verb) {
    const last = nouns[nouns.length - 1];
    switch (method) {
      case "get":
        verb = !endsWithParam && last && isPlural(last) ? "list" : "get";
        break;
      case "post":
        verb = endsWithParam ? "submit" : "create";
        if (!endsWithParam && last) nouns[nouns.length - 1] = singularize(last);
        break;
      case "put":
        verb = "set";
        break;
      case "patch":
        verb = "update";
        break;
      case "delete":
        verb = "delete";
        break;
    }
  }
  return { verb, nouns };
}

/** `listRevenueDeals`. */
export function operationIdFor(name: OperationName): string {
  return `${name.verb}${pascal(name.nouns)}`;
}

/** `List revenue deals`. */
export function summaryFor(name: OperationName): string {
  const words = [...segmentWords(name.verb), ...name.nouns].map((word) => ACRONYMS[word] ?? word);
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export type OperationKey = { method: HttpMethod; path: string };

/** The `{param}` names of an OpenAPI path, in order. */
function templateParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/**
 * Give every operation a unique id, keeping `reserved` ids (the ones written by
 * hand) untouched and away from generated ones. Deterministic: the result
 * depends only on the set of operations, never on their order.
 */
export function assignOperationIds(
  operations: readonly OperationKey[],
  reserved: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const keyOf = (operation: OperationKey) => `${operation.method.toUpperCase()} ${operation.path}`;
  const result = new Map<string, string>();
  const taken = new Set<string>();
  for (const [key, id] of reserved) {
    result.set(key, id);
    taken.add(id);
  }

  const groups = new Map<string, OperationKey[]>();
  for (const operation of operations) {
    if (result.has(keyOf(operation))) continue;
    const base = operationIdFor(operationNameFor(operation.method, operation.path));
    groups.set(base, [...(groups.get(base) ?? []), operation]);
  }

  // Shorter paths first, then alphabetical: the most basic route keeps the plain id.
  const byPriority = (a: OperationKey, b: OperationKey) =>
    a.path.split("/").length - b.path.split("/").length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.method < b.method ? -1 : a.method > b.method ? 1 : 0);

  for (const base of [...groups.keys()].sort()) {
    const members = [...(groups.get(base) ?? [])].sort(byPriority);
    members.forEach((operation, index) => {
      let id = base;
      if (index > 0 || taken.has(id)) {
        const params = templateParams(operation.path).filter((name) => name !== "cid");
        id = `${base}By${pascal(params.flatMap(segmentWords)) || pascal([operation.method])}`;
        for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
      }
      taken.add(id);
      result.set(keyOf(operation), id);
    });
  }
  return result;
}
