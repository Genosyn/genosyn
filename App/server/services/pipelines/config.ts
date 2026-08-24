/**
 * Reading values out of a node's `config` blob.
 *
 * Config is `Record<string, unknown>` written by a form, by an API caller, or
 * by a model, so every read has to cope with the wrong type. What matters here
 * is that the *authoring* check and the *matching* check read a value the same
 * way: a mailbox list parsed one way when an employee is refused and another
 * way when mail arrives is a hole, not a bug. So the readers live together,
 * somewhere both sides can import without dragging the executor along.
 */

/** A comma-separated address list, trimmed, lowercased, blanks dropped. */
export function parseAddressList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}
