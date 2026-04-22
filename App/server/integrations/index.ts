import type {
  IntegrationCatalogEntry,
  IntegrationProvider,
} from "./types.js";
import { stripeProvider } from "./providers/stripe.js";
import { gmailProvider, googleOauthConfigured } from "./providers/gmail.js";
import { metabaseProvider } from "./providers/metabase.js";
import { nocodbProvider } from "./providers/nocodb.js";

/**
 * Provider registry. Adding a new integration means:
 *   1. Implement `IntegrationProvider` under `providers/<name>.ts`.
 *   2. Register it in `PROVIDERS` below.
 *   3. (OAuth only) Extend `services/oauth.ts` to dispatch to its helpers.
 */
const PROVIDERS: Record<string, IntegrationProvider> = {
  [stripeProvider.catalog.provider]: stripeProvider,
  [gmailProvider.catalog.provider]: gmailProvider,
  [metabaseProvider.catalog.provider]: metabaseProvider,
  [nocodbProvider.catalog.provider]: nocodbProvider,
};

export function getProvider(id: string): IntegrationProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Return the catalog entries with `enabled`/`disabledReason` reflecting the
 * current `config.ts`. Static catalog fields come straight from the provider;
 * dynamic fields (OAuth gating) are injected here so provider modules stay
 * pure.
 */
export function listCatalog(): IntegrationCatalogEntry[] {
  return Object.values(PROVIDERS).map((p) => {
    const base = { ...p.catalog };
    if (base.oauth?.app === "google") {
      const ok = googleOauthConfigured();
      base.enabled = ok;
      base.disabledReason = ok
        ? undefined
        : "Set `config.integrations.google.clientId` and `clientSecret` in App/config.ts to enable.";
    }
    return base;
  });
}

export type { IntegrationProvider, IntegrationCatalogEntry } from "./types.js";
