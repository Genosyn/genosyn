/** A named bundle of upstream scopes an operator can offer, e.g. Gmail. */
export type ScopeGroup = {
  key: string;
  /** Shown on the consent page: "Gmail". */
  label: string;
  /** Shown on the consent page: what the installation will be able to do. */
  description: string;
  scopes: readonly string[];
};

export type ProviderRegistration = { clientId: string; clientSecret: string };

/**
 * What an installation receives once. It carries no client secret: renewing
 * the access token comes back through this service's refresh endpoint.
 */
export type ProviderCredential = {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds since the epoch. */
  expiresAt?: number;
  /** Space-separated scopes the person actually granted. */
  scope: string;
  /** A verified address, when the upstream account has one. */
  email?: string;
  /** How the account is shown to people: the address, a handle, or an id. */
  account: string;
};

export type RefreshedToken = {
  accessToken: string;
  expiresAt?: number;
  /** Present only when the upstream rotated it. */
  refreshToken?: string;
  scope?: string;
};

/**
 * One upstream identity provider. Everything provider-specific — endpoints,
 * scopes, consent wording, token validation — lives behind this shape; the
 * broker owns the proof-bound flow and never branches on a provider id.
 */
export type ConnectProvider = {
  /** Lowercase path segment: /api/connect/<id>. */
  id: string;
  /** "Google" */
  name: string;
  /** Origin the consent form redirects to; the page's form-action allows it. */
  authorizationOrigin: string;
  /** Button on the consent page: "Continue with Google". */
  continueLabel: string;
  /** Null until an operator configures this provider's OAuth client. */
  registration: ProviderRegistration | null;
  /** Requested on every sign-in to identify the account; never the point of it. */
  identityScopes: readonly string[];
  /** Every group this provider knows, whether or not the operator offers it. */
  catalog: readonly ScopeGroup[];
  /** The groups the operator chose to offer. */
  groups: readonly ScopeGroup[];
  authorizeUrl(args: {
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    codeChallenge: string;
    state: string;
  }): string;
  exchange(
    args: ProviderRegistration & { code: string; codeVerifier: string; redirectUri: string },
  ): Promise<ProviderCredential>;
  refresh(args: ProviderRegistration & { refreshToken: string }): Promise<RefreshedToken>;
};

/** The scopes an operator's configuration lets an installation ask for. */
export function offeredScopes(provider: ConnectProvider): string[] {
  return [...new Set(provider.groups.flatMap((group) => group.scopes))];
}
