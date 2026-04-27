/**
 * Shared helpers for the Google umbrella provider and its per-product tool
 * modules. Lives here (rather than on `google.ts`) so the tool modules can
 * import it without creating an `gmail-tools → google → gmail-tools` cycle.
 */

export function safeJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
