import type { OauthAppDescriptor } from "./api";

/**
 * The closed line of one provider on Admin → Integrations: whether this
 * installation has registered its own OAuth app for it. A half-typed Client ID
 * stays mounted while the row is shut, so the line says so rather than letting
 * an unsaved edit pass for a saved one (AGENTS.md §8).
 */
export function describeOauthApp(
  app: Pick<OauthAppDescriptor, "configured">,
  dirty = false,
): string {
  const state = app.configured ? "Registered" : "Not registered";
  return dirty ? `${state} · unsaved changes` : state;
}
