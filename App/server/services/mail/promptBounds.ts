/**
 * Size limits shared by the mail surfaces that hand untrusted email text to a
 * model.
 *
 * These live on their own so the rule evaluator and inbound analysis bound
 * their prompts with the same primitive rather than two lookalike copies that
 * drift. A prompt-size guard that is subtly different in one place is a guard
 * that eventually is not one.
 */

/**
 * Truncate so the *encoded* JSON value fits, not just its source characters.
 *
 * A caller that slices to N characters and then serializes can still blow a
 * byte budget: one `"` or backslash in the email becomes two characters, and a
 * body full of them roughly doubles. Binary-search the longest prefix whose
 * `JSON.stringify` output fits, and mark the cut with an ellipsis so the model
 * can see the text was shortened.
 */
export function jsonBoundedString(value: string, maxEncodedChars: number): string {
  if (JSON.stringify(value).length <= maxEncodedChars) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${value.slice(0, middle)}…`).length <= maxEncodedChars) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}…`;
}

/** Attachment filenames only — Genosyn never puts attachment bytes in a prompt. */
export function attachmentNames(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as Array<{ filename?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        typeof item?.filename === "string"
          ? jsonBoundedString(item.filename.slice(0, 200), 202)
          : "",
      )
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}
