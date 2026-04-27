import type {
  IntegrationCatalogEntry,
  IntegrationProvider,
} from "./types.js";
import { stripeProvider } from "./providers/stripe.js";
import { googleProvider } from "./providers/google.js";
import { metabaseProvider } from "./providers/metabase.js";
import { nocodbProvider } from "./providers/nocodb.js";
import { githubProvider } from "./providers/github.js";

/**
 * Provider registry. Adding a new integration means:
 *   1. Implement `IntegrationProvider` under `providers/<name>.ts`.
 *   2. Register it in `PROVIDERS` below.
 *   3. (OAuth only) Extend `services/oauth.ts` to dispatch to its helpers.
 */
const PROVIDERS: Record<string, IntegrationProvider> = {
  [stripeProvider.catalog.provider]: stripeProvider,
  [googleProvider.catalog.provider]: googleProvider,
  [metabaseProvider.catalog.provider]: metabaseProvider,
  [nocodbProvider.catalog.provider]: nocodbProvider,
  [githubProvider.catalog.provider]: githubProvider,
};

export function getProvider(id: string): IntegrationProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Return the static catalog entries verbatim. With per-Connection
 * credentials there is no global "is this integration configured?" check —
 * each Connection brings its own clientId/secret (OAuth) or service-account
 * key, so Google is always available to add.
 */
export function listCatalog(): IntegrationCatalogEntry[] {
  return Object.values(PROVIDERS).map((p) => ({ ...p.catalog }));
}

export type { IntegrationProvider, IntegrationCatalogEntry } from "./types.js";
