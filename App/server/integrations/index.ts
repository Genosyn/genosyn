import type {
  IntegrationCatalogEntry,
  IntegrationProvider,
  RetiredIntegration,
} from "./types.js";
import { stripeProvider } from "./providers/stripe.js";
import { brexProvider } from "./providers/brex.js";
import { googleProvider } from "./providers/google.js";
import { googleAnalyticsProvider } from "./providers/google-analytics.js";
import { googleSearchConsoleProvider } from "./providers/google-search-console.js";
import { githubProvider } from "./providers/github.js";
import { forgejoProvider } from "./providers/forgejo.js";
import { airtableProvider } from "./providers/airtable.js";
import { postgresProvider } from "./providers/postgres.js";
import { mysqlProvider } from "./providers/mysql.js";
import { clickhouseProvider } from "./providers/clickhouse.js";
import { notionProvider } from "./providers/notion.js";
import { linearProvider } from "./providers/linear.js";
import { telegramProvider } from "./providers/telegram.js";
import { slackProvider } from "./providers/slack.js";
import { microsoftTeamsProvider } from "./providers/microsoft-teams.js";
import { whatsappProvider } from "./providers/whatsapp.js";
import { xProvider } from "./providers/x.js";
import { redditProvider } from "./providers/reddit.js";
import { linkedinProvider } from "./providers/linkedin.js";
import { googleAdsProvider } from "./providers/google-ads.js";
import { metaAdsProvider } from "./providers/meta-ads.js";
import { microsoftAdsProvider } from "./providers/microsoft-ads.js";
import { redditAdsProvider } from "./providers/reddit-ads.js";
import { isPublicUrlConfigured } from "../services/publicUrl.js";
import { config } from "../../config.js";

/**
 * Provider registry. Adding a new integration means:
 *   1. Implement `IntegrationProvider` under `providers/<name>.ts`.
 *   2. Register it in `PROVIDERS` below.
 *   3. (OAuth only) Extend `services/oauth.ts` to dispatch to its helpers.
 */
const PROVIDERS: Record<string, IntegrationProvider> = {
  [stripeProvider.catalog.provider]: stripeProvider,
  [brexProvider.catalog.provider]: brexProvider,
  [googleProvider.catalog.provider]: googleProvider,
  [googleAnalyticsProvider.catalog.provider]: googleAnalyticsProvider,
  [googleSearchConsoleProvider.catalog.provider]: googleSearchConsoleProvider,
  [githubProvider.catalog.provider]: githubProvider,
  [forgejoProvider.catalog.provider]: forgejoProvider,
  [airtableProvider.catalog.provider]: airtableProvider,
  [postgresProvider.catalog.provider]: postgresProvider,
  [mysqlProvider.catalog.provider]: mysqlProvider,
  [clickhouseProvider.catalog.provider]: clickhouseProvider,
  [notionProvider.catalog.provider]: notionProvider,
  [linearProvider.catalog.provider]: linearProvider,
  [telegramProvider.catalog.provider]: telegramProvider,
  [slackProvider.catalog.provider]: slackProvider,
  [microsoftTeamsProvider.catalog.provider]: microsoftTeamsProvider,
  [whatsappProvider.catalog.provider]: whatsappProvider,
  [xProvider.catalog.provider]: xProvider,
  [redditProvider.catalog.provider]: redditProvider,
  [linkedinProvider.catalog.provider]: linkedinProvider,
  [googleAdsProvider.catalog.provider]: googleAdsProvider,
  [metaAdsProvider.catalog.provider]: metaAdsProvider,
  [microsoftAdsProvider.catalog.provider]: microsoftAdsProvider,
  [redditAdsProvider.catalog.provider]: redditAdsProvider,
};

const SHARED_SAAS_BLOCKED_PROVIDERS = new Set(["postgres", "mysql"]);

/**
 * Chat surfaces (M59) whose only inbound path is an HTTP webhook, so a
 * Connection is worthless until the instance has a public URL Microsoft or
 * Meta can POST to.
 *
 * **Telegram and Slack are deliberately absent.** Their transports dial *out* —
 * Telegram long-polls, Slack holds a Socket Mode WebSocket — so both reach an
 * AI Employee from a laptop behind NAT with nothing published. That asymmetry
 * is the whole reachability story of M59, and it is why this is a set of two
 * rather than a blanket rule over the four.
 *
 * The ids are written out rather than read from `requiresPublicUrl` on the
 * adapters in `services/chatSurfaces/adapters.ts`, which is where that flag
 * actually lives. This module is the connector catalog and nearly every
 * service imports it; the adapter registry drags all four transports and the
 * entire entity graph behind it, and it sits one edit away from closing a
 * cycle back here — the two long-running adapters reach
 * `services/integrations.ts` at call time precisely to stay out of one. A
 * two-entry literal is the cheaper thing to keep honest. Adding another
 * webhook-only surface means editing both places.
 */
const PUBLIC_URL_REQUIRED_PROVIDERS = new Set(["microsoft-teams", "whatsapp"]);

/**
 * Connectors that used to be registered above and no longer are.
 *
 * The Vault made most of them redundant: a credential the company keeps in
 * the Vault, plus the App browser, reaches these services without a bespoke
 * provider module to maintain. Removing the module does not remove the
 * `IntegrationConnection` rows an operator already created, so this table
 * keeps the ids meaningful — the connection list explains what happened
 * instead of rendering an anonymous broken card, and the Vault backfill
 * (`services/retiredIntegrationVaultBackfill.ts`) uses it to decide which
 * rows to move.
 *
 * Entries are permanent. An id that appears here must never be reused for a
 * new provider: a stale row would silently adopt the new provider's meaning.
 */
const RETIRED_PROVIDERS: Record<string, RetiredIntegration> = {
  nostr: {
    provider: "nostr",
    name: "Nostr",
    retiredIn: "1.132.0",
    reason: "Keep the account key in the Vault and reach relays from a Skill.",
  },
  lightning: {
    provider: "lightning",
    name: "Lightning (Nostr Wallet Connect)",
    retiredIn: "1.132.0",
    reason: "Keep the wallet connection string in the Vault.",
  },
  "lightning-lnd": {
    provider: "lightning-lnd",
    name: "Lightning (LND)",
    retiredIn: "1.132.0",
    reason: "Keep the node macaroon and TLS certificate in the Vault.",
  },
  "hacker-news": {
    provider: "hacker-news",
    name: "Hacker News",
    retiredIn: "1.132.0",
    reason: "Keep the login in the Vault and browse the site with the App browser.",
  },
  nocodb: {
    provider: "nocodb",
    name: "NocoDB",
    retiredIn: "1.132.0",
    reason: "Keep the API token in the Vault, or use native Bases.",
  },
  metabase: {
    provider: "metabase",
    name: "Metabase",
    retiredIn: "1.132.0",
    reason: "Keep the API key in the Vault, or use native Explore.",
  },
  redis: {
    provider: "redis",
    name: "Redis",
    retiredIn: "1.132.0",
    reason: "Keep the connection URL in the Vault.",
  },
  "people-data-labs": {
    provider: "people-data-labs",
    name: "People Data Labs",
    retiredIn: "1.132.0",
    reason: "Keep the API key in the Vault. Revenue no longer runs firmographic lookups.",
  },
};

/**
 * Look up a retired connector by id. Returns `null` for ids that were never
 * registered at all, which callers should treat as an unknown provider
 * rather than a retirement.
 */
export function getRetiredProvider(id: string): RetiredIntegration | null {
  return RETIRED_PROVIDERS[id] ?? null;
}

export function listRetiredProviderIds(): string[] {
  return Object.keys(RETIRED_PROVIDERS);
}


export function assertIntegrationAllowed(providerId: string): void {
  if (config.security.multiTenant && SHARED_SAAS_BLOCKED_PROVIDERS.has(providerId)) {
    throw new Error(
      `${providerId} Connections are disabled in shared SaaS mode until raw TCP integrations run in a dedicated egress worker`,
    );
  }
}

export function getProvider(id: string): IntegrationProvider | null {
  return PROVIDERS[id] ?? null;
}

/**
 * Whether a provider accepts an API-key / personal-access-token Connection.
 *
 * `catalog.authMode` only names the provider's *primary* connect mode, so it
 * can't be used to gate the API-key path: GitHub's primary mode is `oauth2`,
 * but it also accepts a Personal Access Token as a secondary mode. The real
 * signal is the provider implementing `validateApiKey` alongside a non-empty
 * `fields` block to collect the token — that covers both pure API-key
 * integrations (Stripe, Linear, …) and OAuth integrations with a secondary
 * token path (GitHub). This mirrors the client's `supportsApiKey` check.
 */
export function providerSupportsApiKey(provider: IntegrationProvider): boolean {
  return !!provider.validateApiKey && (provider.catalog.fields?.length ?? 0) > 0;
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Why this instance cannot offer a connector right now, or null when it can.
 *
 * Both reasons are instance state rather than provider state, which is why
 * they are resolved per call instead of baked into `catalog.enabled`: an
 * operator who saves a public URL should find Microsoft Teams and WhatsApp
 * connectable on the next page load, with no restart.
 */
function catalogDisabledReason(providerId: string): string | null {
  if (config.security.multiTenant && SHARED_SAAS_BLOCKED_PROVIDERS.has(providerId)) {
    return "Unavailable in shared SaaS until isolated raw-TCP egress is configured.";
  }
  if (PUBLIC_URL_REQUIRED_PROVIDERS.has(providerId) && !isPublicUrlConfigured()) {
    return "Set Admin → General → Public URL first — this surface only receives messages at a webhook, so it needs an address the platform can reach.";
  }
  return null;
}

/**
 * Return the catalog entries. There is no global "is this integration
 * configured?" check — a Connection may always bring its own clientId/secret
 * (OAuth) or service-account key, so Google is always available to add.
 *
 * `registeredOauthApps` is the one piece of instance state a *caller* folds
 * in: the set of OAuth apps a master admin registered install-wide. Entries
 * whose OAuth app is in that set are marked `oauth.instanceApp`, which is how
 * the connect form knows it can skip asking for credentials entirely. Callers
 * that don't care (onboarding recommendations) omit it and get the static
 * shape — but they still get {@link catalogDisabledReason}, because a card
 * recommending a connector that cannot work here is worse than no card.
 */
export function listCatalog(
  opts: { registeredOauthApps?: ReadonlySet<string> } = {},
): IntegrationCatalogEntry[] {
  const registered = opts.registeredOauthApps;
  return Object.values(PROVIDERS).map((p) => {
    const disabledReason = catalogDisabledReason(p.catalog.provider);
    const entry: IntegrationCatalogEntry = disabledReason
      ? { ...p.catalog, enabled: false, disabledReason }
      : { ...p.catalog };
    if (entry.oauth && registered?.has(entry.oauth.app)) {
      entry.oauth = { ...entry.oauth, instanceApp: true };
    }
    return entry;
  });
}

export type {
  IntegrationProvider,
  IntegrationCatalogEntry,
  RetiredIntegration,
} from "./types.js";
