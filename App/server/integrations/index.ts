import type {
  IntegrationCatalogEntry,
  IntegrationProvider,
} from "./types.js";
import { stripeProvider } from "./providers/stripe.js";
import { googleProvider } from "./providers/google.js";
import { googleAnalyticsProvider } from "./providers/google-analytics.js";
import { googleSearchConsoleProvider } from "./providers/google-search-console.js";
import { metabaseProvider } from "./providers/metabase.js";
import { nocodbProvider } from "./providers/nocodb.js";
import { githubProvider } from "./providers/github.js";
import { airtableProvider } from "./providers/airtable.js";
import { postgresProvider } from "./providers/postgres.js";
import { mysqlProvider } from "./providers/mysql.js";
import { clickhouseProvider } from "./providers/clickhouse.js";
import { redisProvider } from "./providers/redis.js";
import { notionProvider } from "./providers/notion.js";
import { linearProvider } from "./providers/linear.js";
import { telegramProvider } from "./providers/telegram.js";
import { xProvider } from "./providers/x.js";
import { nostrProvider } from "./providers/nostr.js";
import { lightningProvider } from "./providers/lightning.js";
import { lightningLndProvider } from "./providers/lightning-lnd.js";
import { redditProvider } from "./providers/reddit.js";
import { linkedinProvider } from "./providers/linkedin.js";
import { googleAdsProvider } from "./providers/google-ads.js";
import { metaAdsProvider } from "./providers/meta-ads.js";
import { microsoftAdsProvider } from "./providers/microsoft-ads.js";
import { redditAdsProvider } from "./providers/reddit-ads.js";

/**
 * Provider registry. Adding a new integration means:
 *   1. Implement `IntegrationProvider` under `providers/<name>.ts`.
 *   2. Register it in `PROVIDERS` below.
 *   3. (OAuth only) Extend `services/oauth.ts` to dispatch to its helpers.
 */
const PROVIDERS: Record<string, IntegrationProvider> = {
  [stripeProvider.catalog.provider]: stripeProvider,
  [googleProvider.catalog.provider]: googleProvider,
  [googleAnalyticsProvider.catalog.provider]: googleAnalyticsProvider,
  [googleSearchConsoleProvider.catalog.provider]: googleSearchConsoleProvider,
  [metabaseProvider.catalog.provider]: metabaseProvider,
  [nocodbProvider.catalog.provider]: nocodbProvider,
  [githubProvider.catalog.provider]: githubProvider,
  [airtableProvider.catalog.provider]: airtableProvider,
  [postgresProvider.catalog.provider]: postgresProvider,
  [mysqlProvider.catalog.provider]: mysqlProvider,
  [clickhouseProvider.catalog.provider]: clickhouseProvider,
  [redisProvider.catalog.provider]: redisProvider,
  [notionProvider.catalog.provider]: notionProvider,
  [linearProvider.catalog.provider]: linearProvider,
  [telegramProvider.catalog.provider]: telegramProvider,
  [xProvider.catalog.provider]: xProvider,
  [nostrProvider.catalog.provider]: nostrProvider,
  [lightningProvider.catalog.provider]: lightningProvider,
  [lightningLndProvider.catalog.provider]: lightningLndProvider,
  [redditProvider.catalog.provider]: redditProvider,
  [linkedinProvider.catalog.provider]: linkedinProvider,
  [googleAdsProvider.catalog.provider]: googleAdsProvider,
  [metaAdsProvider.catalog.provider]: metaAdsProvider,
  [microsoftAdsProvider.catalog.provider]: microsoftAdsProvider,
  [redditAdsProvider.catalog.provider]: redditAdsProvider,
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
