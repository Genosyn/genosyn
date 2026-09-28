import type {
  IntegrationAuthMode,
  IntegrationConfig,
  IntegrationProvider,
} from "../integrations/types.js";
import { assertSafeOutboundConfig } from "../lib/outboundUrl.js";

/**
 * OAuth factories persist `scope` as identifiers granted by the issuer, not
 * network destinations. URI-shaped scopes must not create a DNS dependency
 * before a provider request (Google scopes name www.googleapis.com while
 * Gmail requests use gmail.googleapis.com).
 *
 * Only that reserved metadata field, in a provider-owned OAuth config, is
 * excluded. A provider exposing a form field of that name keeps the strict
 * validator instead. Every actual URL/host field still uses the ordinary
 * public-network policy, including custom endpoints on OAuth Connections.
 */
export async function assertSafeIntegrationConfig(args: {
  provider: IntegrationProvider;
  authMode: IntegrationAuthMode;
  config: IntegrationConfig;
}): Promise<void> {
  const { provider, authMode, config } = args;
  const declaresScopeInput = [
    ...(provider.catalog.fields ?? []),
    ...(provider.catalog.oauth?.extraFields ?? []),
  ].some((field) => field.key === "scope");
  if (
    authMode === "oauth2" &&
    provider.catalog.oauth &&
    provider.buildOauthConfig &&
    !declaresScopeInput
  ) {
    const { scope: _scope, ...destinations } = config;
    await assertSafeOutboundConfig(destinations);
    return;
  }
  await assertSafeOutboundConfig(config);
}
