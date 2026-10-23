/**
 * The Streamable HTTP rules the Genosyn MCP endpoint applies before a message
 * reaches the MCP server: which browser origins may call it, how lenient to be
 * with `Accept`, and how many messages one POST may carry.
 */

/**
 * The MCP transport asks servers to validate `Origin` on every request, so a
 * web page cannot drive one through a visitor's browser (DNS rebinding). MCP
 * clients — Claude Desktop and Claude Code, Cursor, n8n, an SDK — are programs
 * and send no `Origin`. A browser always does; the only browser origin
 * accepted is this install's own public URL. Comparing against the request's
 * `Host` instead would accept exactly the rebinding attack the rule exists
 * for, where the attacker's name is in both.
 */
export function isAllowedOrigin(origin: string | undefined, publicUrl: string): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    // "null" from a sandboxed frame or a file: page, or a joined duplicate.
    return false;
  }
}

/**
 * The `Accept` value to hand the MCP SDK. The transport requires a client to
 * accept both JSON and an event stream, but this server always answers with
 * JSON and never streams. So a client that accepts JSON — by sending no
 * `Accept`, a wildcard, or `application/json` alone, as a plain HTTP client
 * does — accepts everything it will get, and is let through as if it had listed
 * both. One that rules JSON out is left for the SDK to refuse with 406.
 */
export function normalizedAccept(accept: string | undefined): string | null {
  const value = accept?.trim().toLowerCase() ?? "";
  if (value.includes("application/json") && value.includes("text/event-stream")) return null;
  const acceptsJson =
    value === "" ||
    value
      .split(",")
      .map((range) => range.split(";")[0]?.trim())
      .some(
        (range) => range === "*/*" || range === "application/*" || range === "application/json",
      );
  return acceptsJson ? "application/json, text/event-stream" : null;
}

/** JSON-RPC batches are gone from the current protocol; older clients still send small ones. */
export const MAX_BATCH_MESSAGES = 20;

/** The largest JSON-RPC body the endpoint reads — room for a file sent as base64. */
export const MAX_BODY = "10mb";

/** What the rest of the App accepts as a JSON body, and what any body here may be besides a file. */
export const PLAIN_BODY_LIMIT_BYTES = 1024 * 1024;

const isBase64Byte = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) || // 0-9
  (byte >= 0x41 && byte <= 0x5a) || // A-Z
  (byte >= 0x61 && byte <= 0x7a) || // a-z
  byte === 0x2b || // +
  byte === 0x2f || // /
  byte === 0x3d || // =
  byte === 0x2d || // -
  byte === 0x5f; // _

/** The length of the longest JSON string in `body` made only of base64 characters. */
export function longestQuotedBase64(body: Buffer): number {
  let longest = 0;
  let start = -1;
  for (let index = 0; index < body.length; index++) {
    if (isBase64Byte(body[index])) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      // Only a run that is a whole JSON string — quoted on both sides — counts.
      if (body[index] === 0x22 && start > 0 && body[start - 1] === 0x22) {
        longest = Math.max(longest, index - start);
      }
      start = -1;
    }
  }
  return longest;
}

/**
 * Why a JSON body is refused before it is parsed, or null to parse it.
 *
 * Parsing JSON blocks the process, and a body of many small values — tens of
 * thousands of `{}` — takes seconds to parse where a file's single long string
 * takes milliseconds. So the endpoint reads up to `MAX_BODY` for the one thing
 * that needs it, a file sent as base64, and nothing else: past the 1 MB every
 * other route allows, all the rest must be one base64 string.
 */
export function oversizedBodyProblem(body: Buffer): string | null {
  if (body.length <= PLAIN_BODY_LIMIT_BYTES) return null;
  if (body.length - longestQuotedBase64(body) <= PLAIN_BODY_LIMIT_BYTES) return null;
  return "The request is too large: past 1 MB, a request may carry only a file, as one base64 string without line breaks.";
}

/** A JSON-RPC error with no request id, for refusals before any message is read. */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

/**
 * Why a batch is refused, or null. Each request in a batch must have its own
 * id: the SDK files answers by id, so a repeated one would lose an answer.
 */
export function batchProblem(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  if (body.length > MAX_BATCH_MESSAGES) {
    return `A batch may hold at most ${MAX_BATCH_MESSAGES} messages.`;
  }
  const ids = new Set<string>();
  for (const message of body) {
    const record = message as { id?: unknown; method?: unknown } | null;
    if (!record || typeof record !== "object" || record.method === undefined) continue;
    if (record.id === undefined || record.id === null) continue;
    const key = `${typeof record.id}:${String(record.id)}`;
    if (ids.has(key))
      return `Each request in a batch needs its own id; ${String(record.id)} is repeated.`;
    ids.add(key);
  }
  return null;
}
