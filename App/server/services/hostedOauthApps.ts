import {
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  hasGoogleGmailMailboxScope,
  resolveScopeGroups,
} from "../integrations/providers/google/auth.js";
import type { IntegrationProvider } from "../integrations/types.js";

/**
 * Which Integration OAuth apps can sign in through Genosyn Connect, and how.
 *
 * Genosyn Connect is the hosted sign-in service (connect.genosyn.com by
 * default, `Connect/` in this repository). It owns one registered OAuth app
 * per provider, so a self-hosted installation can connect an Integration
 * without registering its own. This table is the installation's half of that
 * contract; the service's half is its provider adapter. Adding a provider
 * means an entry in both — plus the provider's own refresh hook, the way
 * `google/auth.ts` calls `refreshHostedOauthToken`.
 *
 * This module is pure on purpose: the Integration catalog imports it, and the
 * catalog cannot import anything that imports the catalog.
 */
export type HostedOauthApp = {
  /** Path segment on the service: `/api/connect/<connectProvider>`. */
  connectProvider: string;
  /** "Google", for messages. */
  name: string;
  /** Scopes the service adds to every request to identify the account. */
  identityScopes: readonly string[];
  /**
   * What a service released before scopes were negotiable grants. It reports
   * no scope list, and it grants these and nothing else.
   */
  legacyScopes: readonly string[];
  /** Why a completed sign-in cannot be used, or null when it can. */
  credentialProblem(args: {
    credential: {
      refreshToken?: string;
      expiresAt?: number;
      email?: string;
      scope: string;
    };
    requestedScopes: readonly string[];
    linkMailbox: boolean;
  }): string | null;
};

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

export const HOSTED_OAUTH_APPS: Readonly<Record<string, HostedOauthApp>> = Object.freeze({
  google: {
    connectProvider: "google",
    name: "Google",
    identityScopes: GOOGLE_OAUTH_IDENTITY_SCOPES,
    legacyScopes: GMAIL_SCOPES,
    credentialProblem({ credential, requestedScopes, linkMailbox }) {
      if (!credential.refreshToken || !credential.expiresAt || !credential.email) {
        return "Google sign-in finished without lasting access. Start again.";
      }
      if (credential.expiresAt <= Date.now()) {
        return "Google sign-in expired before it could be saved. Start again.";
      }
      const granted = credential.scope.split(/\s+/).filter(Boolean);
      // A Gmail Connection that cannot read the mailbox is no Connection at
      // all, so Gmail is all-or-nothing even when other products are not.
      const wantsMailbox = linkMailbox || hasGoogleGmailMailboxScope([...requestedScopes]);
      if (wantsMailbox && !hasGoogleGmailMailboxScope(granted)) {
        return "Google did not grant Gmail access. Start again and allow Gmail access on the consent screen.";
      }
      const product = requestedScopes.filter(
        (scope) => !GOOGLE_OAUTH_IDENTITY_SCOPES.includes(scope),
      );
      if (!product.some((scope) => granted.includes(scope))) {
        return "Google did not grant access to anything you chose. Start again and allow access on the consent screen.";
      }
      return null;
    },
  },
});

export function hostedOauthApp(app: string | undefined): HostedOauthApp | undefined {
  return app ? HOSTED_OAUTH_APPS[app] : undefined;
}

/** The scopes an Integration asks for with these groups, exactly as a direct sign-in would. */
export function integrationOauthScopes(
  provider: IntegrationProvider,
  scopeGroups: readonly string[],
): string[] {
  const oauth = provider.catalog.oauth;
  if (!oauth) return [];
  return resolveScopeGroups({
    keys: [...scopeGroups],
    groups: oauth.scopeGroups ?? [],
    baseline: oauth.scopes,
  });
}

/** Everything in `scopes` except what the service adds by itself. */
export function productScopes(hosted: HostedOauthApp, scopes: readonly string[]): string[] {
  return scopes.filter((scope) => !hosted.identityScopes.includes(scope));
}

/**
 * The scope groups of an Integration that a service offering `offered` can
 * grant in full. Empty when even the Integration's baseline is not offered.
 */
export function hostedScopeGroups(
  provider: IntegrationProvider,
  offered: ReadonlySet<string>,
): string[] {
  const oauth = provider.catalog.oauth;
  const hosted = hostedOauthApp(oauth?.app);
  if (!oauth || !hosted) return [];
  if (!productScopes(hosted, oauth.scopes).every((scope) => offered.has(scope))) return [];
  return (oauth.scopeGroups ?? [])
    .filter((group) => group.scopes.length > 0 && group.scopes.every((scope) => offered.has(scope)))
    .map((group) => group.key);
}

/** Labels of the groups whose scopes include any of `scopes`, for messages. */
export function scopeGroupLabels(provider: IntegrationProvider, scopes: readonly string[]): string {
  const wanted = new Set(scopes);
  const labels = (provider.catalog.oauth?.scopeGroups ?? [])
    .filter((group) => group.scopes.some((scope) => wanted.has(scope)))
    .map((group) => group.label);
  return labels.length > 0 ? labels.join(", ") : scopes.join(", ");
}
