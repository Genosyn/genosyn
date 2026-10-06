import type { ConnectConfig } from "../config.js";
import type { Fetch } from "../upstream.js";
import { createGoogleProvider, DEFAULT_GOOGLE_SCOPE_GROUPS } from "./google.js";
import type { ConnectProvider } from "./types.js";

export type ProviderRegistry = ReadonlyMap<string, ConnectProvider>;

/**
 * Every provider this build knows, configured or not. An unconfigured provider
 * still answers its status route with `available: false`, so an installation
 * can tell "not offered here" from "this service is down".
 *
 * Adding a provider means a new adapter in this folder, its OAuth client in
 * the config loader, and tests — never a provider name or endpoint taken from
 * a request.
 */
export function createProviders(
  config: ConnectConfig,
  options: { fetch?: Fetch } = {},
): ProviderRegistry {
  const google = createGoogleProvider({
    registration: config.google
      ? { clientId: config.google.clientId, clientSecret: config.google.clientSecret }
      : null,
    groups: config.google?.scopeGroups ?? DEFAULT_GOOGLE_SCOPE_GROUPS,
    fetch: options.fetch,
  });
  return new Map([[google.id, google]]);
}
