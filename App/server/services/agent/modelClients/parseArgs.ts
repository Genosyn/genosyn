/**
 * Parse the JSON argument blob an OpenAI-shaped model sends with a tool call.
 *
 * Shared by both OpenAI-shaped clients (Chat Completions and Responses), which
 * carried a byte-identical copy of this until it grew a diagnostic — and a
 * diagnostic that only exists on one provider is worse than none, because the
 * same model failure then reads differently depending on which endpoint served
 * it.
 *
 * ## Why the failure has to be visible
 *
 * The old version answered a malformed blob with `{}`. The model then got the
 * endpoint's zod complaint that some required field was missing, which is a lie
 * about what went wrong: the field was probably there, in JSON the model
 * mangled. It would then re-send the same mangled shape.
 *
 * That was survivable while every tool had a narrow typed schema. It isn't now:
 * `call_tool` (see `../tools/discovery.ts`) carries the arguments for every
 * deferred tool inside a single `args_json` **string**, so a dropped escape is
 * the most likely way a deferred call fails, and "name is required" is the least
 * useful thing we could say about it.
 *
 * So a parse failure comes back as `parseError` *and* is stamped into the parsed
 * input under {@link PARSE_ERROR_KEY}. The stamp is what survives the trip
 * through `AssistantTurn.blocks` into `AgentTool.run` — nothing else in the
 * runtime has a channel for "this call arrived corrupt", and adding one to
 * `ToolUseBlock` would touch every client.
 */

/** Where a parse failure is stamped so `run()` can find it. */
export const PARSE_ERROR_KEY = "__parse_error";

export type ParsedArgs = {
  /** Always an object, so callers never have to null-check. */
  input: Record<string, unknown>;
  /** Human-readable reason the blob didn't parse, absent when it did. */
  parseError?: string;
};

export function parseArgs(raw: string): ParsedArgs {
  const s = (raw ?? "").trim();
  // An argument-less call is normal, not a failure.
  if (!s) return { input: {} };

  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch (e) {
    return fail(
      `arguments were not valid JSON (${e instanceof Error ? e.message : String(e)})`,
      s,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(
      `arguments parsed to ${Array.isArray(value) ? "an array" : typeof value}, but a JSON object was expected`,
      s,
    );
  }

  return { input: value as Record<string, unknown> };
}

/**
 * Build the failure result, quoting enough of the offending text for the model
 * to spot its own mistake without echoing a whole file body back at it.
 */
function fail(reason: string, source: string): ParsedArgs {
  const excerpt = source.length > 200 ? `${source.slice(0, 200)}…` : source;
  const parseError = `${reason}. Received: ${excerpt}`;
  return { input: { [PARSE_ERROR_KEY]: parseError }, parseError };
}
