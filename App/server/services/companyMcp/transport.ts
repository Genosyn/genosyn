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

/** A JSON-RPC error with no request id, for refusals before any message is read. */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}
