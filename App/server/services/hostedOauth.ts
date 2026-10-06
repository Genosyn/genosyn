import crypto from "node:crypto";
import { z } from "zod";
import { getProvider, listProviderIds } from "../integrations/index.js";
import type { IntegrationConfig } from "../integrations/types.js";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowStateSnapshot,
  createAuthFlowState,
  readAuthFlowState,
  type AuthFlowStateSnapshot,
} from "./authFlowState.js";
import { completeOauth } from "./completeOauth.js";
import {
  HOSTED_OAUTH_APPS,
  hostedOauthApp,
  hostedScopeGroups,
  integrationOauthScopes,
  productScopes,
  scopeGroupLabels,
  type HostedOauthApp,
} from "./hostedOauthApps.js";
import { LEGACY_GOOGLE_BROKER_PATH, type HostedOauthCredentials } from "./hostedOauthTokens.js";
import {
  discoverHostedSignIn,
  readHostedSignInOffer,
  requestHostedSignIn,
  resetHostedSignInDiscoveryForTests,
  type HostedSignInOffer,
} from "./hostedSignInTransport.js";
import { getPublicUrl } from "./publicUrl.js";
import { getRuntimeOauthSettings, normalizeSignInUrl } from "./runtimeSettings.js";

/**
 * Sign in to an Integration through Genosyn Connect, the hosted sign-in
 * service, instead of an OAuth app registered on this installation.
 *
 * The installation's server starts the sign-in with two proofs, the person's
 * browser completes consent on the service, and the server collects the
 * credential once with the verifier only it holds. Tokens never touch the
 * browser, and the service never needs to reach this installation, so a
 * laptop on `localhost` works the same as a public server. From then on the
 * installation talks to the provider directly; only token renewal goes back
 * to the service that issued the Connection.
 */

// Historical name, from when only Gmail used this; in-flight attempts keep it.
const FLOW_KIND = "hosted-google-consumer";
const FLOW_TTL_MS = 10 * 60_000;
const LEASE_MS = 30_000;
const RESTART = "This sign-in expired or was already used. Start again.";

const credentialSchema = z.object({
  clientId: z.string().min(1).max(512),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  expiresAt: z.number().finite().positive().optional(),
  scope: z.string().max(8192),
  email: z.string().email().max(320).optional(),
  account: z.string().min(1).max(320).optional(),
});
const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied"), detail: z.string().max(2000).optional() }),
  z.object({ status: z.literal("complete"), credential: credentialSchema }),
]);

type HostedAttempt = {
  companyId: string;
  userId: string;
  label: string;
  /** Integration id. Attempts saved before other providers existed omit it: Google. */
  provider?: string;
  /** Attempts saved before groups were negotiable omit it: Gmail. */
  scopeGroups?: string[];
  requestedScopes?: string[];
  extraFields?: Record<string, string>;
  tokenBrokerUrl: string;
  tokenBrokerPath?: string;
  requestId: string;
  codeVerifier: string;
  existingConnectionId?: string;
  linkMailbox: boolean;
  pollingUntil?: number;
};

export type OauthStartResult = {
  authorizeUrl: string;
  hostedAttempt?: string;
  hostedBrowserProof?: string;
  expiresAt?: number;
};
export type HostedOauthPollResult = {
  status: "pending" | "denied" | "complete";
  detail?: string;
};

export type HostedSignInAvailability =
  | { status: "available"; issuer: string; offer: HostedSignInOffer; scopes: ReadonlySet<string> }
  | { status: "disabled" | "unsupported" | "unreachable"; issuer: string | null };

function offeredScopes(hosted: HostedOauthApp, offer: HostedSignInOffer): ReadonlySet<string> {
  return new Set(offer.scopes ?? hosted.legacyScopes);
}

/**
 * Whether Genosyn Connect can sign in to an OAuth app here, and what it
 * offers. A configured address is not evidence: the service is asked, and an
 * answer is cached for half a minute.
 */
export async function hostedSignInAvailability(app: string): Promise<HostedSignInAvailability> {
  const settings = getRuntimeOauthSettings();
  const issuer = normalizeSignInUrl(settings.hostedSignInUrl);
  const hosted = hostedOauthApp(app);
  if (!hosted) return { status: "unsupported", issuer };
  if (!settings.hostedSignInEnabled || !issuer) return { status: "disabled", issuer };
  try {
    const offer = await discoverHostedSignIn(issuer, hosted.connectProvider);
    if (!offer) return { status: "unsupported", issuer };
    return { status: "available", issuer, offer, scopes: offeredScopes(hosted, offer) };
  } catch {
    return { status: "unreachable", issuer };
  }
}

/** For the catalog: per OAuth app without a local registration, what the service offers. */
export async function hostedSignInOffers(
  registeredOauthApps: ReadonlySet<string>,
  apps: readonly string[],
): Promise<Map<string, ReadonlySet<string>>> {
  const offers = new Map<string, ReadonlySet<string>>();
  for (const app of new Set(apps)) {
    if (registeredOauthApps.has(app)) continue;
    const availability = await hostedSignInAvailability(app);
    if (availability.status === "available") offers.set(app, availability.scopes);
  }
  return offers;
}

export type HostedSignInReport = {
  enabled: boolean;
  url: string;
  apps: Array<{
    app: string;
    name: string;
    /** "registered": this installation uses its own app, so the service is not asked. */
    status: HostedSignInAvailability["status"] | "registered";
    /** Each Integration on this app the service can sign in to, with the products it covers. */
    integrations: Array<{ provider: string; name: string; groups: string[] }>;
  }>;
};

/** What an instance admin sees at Admin → Runtime: is the service reachable, and for what. */
export async function describeHostedSignIn(
  registeredOauthApps: ReadonlySet<string>,
): Promise<HostedSignInReport> {
  const settings = getRuntimeOauthSettings();
  const apps: HostedSignInReport["apps"] = [];
  for (const [app, hosted] of Object.entries(HOSTED_OAUTH_APPS)) {
    if (registeredOauthApps.has(app)) {
      apps.push({ app, name: hosted.name, status: "registered", integrations: [] });
      continue;
    }
    const availability = await hostedSignInAvailability(app);
    const integrations: HostedSignInReport["apps"][number]["integrations"] = [];
    if (availability.status === "available") {
      for (const id of listProviderIds()) {
        const provider = getProvider(id);
        if (!provider || provider.catalog.oauth?.app !== app) continue;
        const covered = hostedScopeGroups(provider, availability.scopes);
        if (covered.length === 0) continue;
        integrations.push({
          provider: id,
          name: provider.catalog.name,
          groups: (provider.catalog.oauth.scopeGroups ?? [])
            .filter((group) => covered.includes(group.key))
            .map((group) => group.label),
        });
      }
    }
    apps.push({ app, name: hosted.name, status: availability.status, integrations });
  }
  return { enabled: settings.hostedSignInEnabled, url: settings.hostedSignInUrl, apps };
}

export function resetHostedOauthAvailabilityForTests(): void {
  resetHostedSignInDiscoveryForTests();
}

function unavailable(name: string): Error {
  return new Error(
    `${name} sign-in through Genosyn Connect is unavailable. Try again later, or ask an instance admin to register a ${name} OAuth app at Admin → Integrations.`,
  );
}

export async function startHostedOauth(args: {
  companyId: string;
  userId: string;
  /** Integration id, e.g. "google" or "google-analytics". */
  provider: string;
  label: string;
  scopeGroups: string[];
  extraFields?: Record<string, string>;
  existingConnectionId?: string;
  linkMailbox?: boolean;
  installationOrigin?: string;
  /** Reconnects stay with the service and protocol that issued the Connection. */
  tokenBrokerUrl?: string;
  tokenBrokerPath?: string;
}): Promise<OauthStartResult> {
  const integration = getProvider(args.provider);
  const hosted = hostedOauthApp(integration?.catalog.oauth?.app);
  if (!integration || !hosted) {
    throw new Error(
      `${integration?.catalog.name ?? args.provider} cannot sign in through Genosyn Connect.`,
    );
  }
  const settings = getRuntimeOauthSettings();
  if (!settings.hostedSignInEnabled) throw unavailable(hosted.name);
  const issuer = normalizeSignInUrl(args.tokenBrokerUrl ?? settings.hostedSignInUrl);
  if (!issuer) throw unavailable(hosted.name);

  const requestedScopes = integrationOauthScopes(integration, args.scopeGroups);
  const product = productScopes(hosted, requestedScopes);
  if (product.length === 0) throw new Error("Choose at least one product to connect.");

  let offer: HostedSignInOffer | null;
  try {
    // Reconnects and existing credentials keep their original protocol as
    // well as their issuer. Discovery never sends a credential.
    offer = args.tokenBrokerUrl
      ? await readHostedSignInOffer(
          issuer,
          hosted.connectProvider,
          args.tokenBrokerPath ?? LEGACY_GOOGLE_BROKER_PATH,
        )
      : await discoverHostedSignIn(issuer, hosted.connectProvider);
  } catch {
    throw unavailable(hosted.name);
  }
  if (!offer) throw unavailable(hosted.name);
  const offered = offeredScopes(hosted, offer);
  const missing = product.filter((scope) => !offered.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `Genosyn Connect does not offer ${scopeGroupLabels(integration, missing)} for ${hosted.name}. Choose only what it offers, or use your own OAuth client for the rest.`,
    );
  }

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  // Independent browser proof binds the service's consent page to the browser
  // actually visiting this installation. It cannot redeem the result.
  const hostedBrowserProof = crypto.randomBytes(32).toString("base64url");
  const browserChallenge = crypto
    .createHash("sha256")
    .update(hostedBrowserProof)
    .digest("base64url");
  try {
    const started = z
      .object({
        requestId: z.string().min(1).max(256),
        authorizeUrl: z.string().url().max(8192),
        expiresAt: z.number().finite().positive(),
      })
      .parse(
        await requestHostedSignIn(issuer, hosted.connectProvider, offer.path, "start", {
          codeChallenge,
          browserChallenge,
          installationOrigin: new URL(args.installationOrigin ?? getPublicUrl()).origin,
          // A service that predates scope negotiation grants exactly its
          // default and rejects a request that names anything.
          ...(offer.scopes ? { scopes: requestedScopes } : {}),
        }),
      );
    const authorize = new URL(started.authorizeUrl);
    if (
      authorize.origin !== new URL(issuer).origin ||
      authorize.username ||
      authorize.password ||
      authorize.pathname !== `${offer.path}/authorize` ||
      authorize.searchParams.get("requestId") !== started.requestId ||
      authorize.hash
    ) {
      throw new Error("Unexpected consent address");
    }
    const expiresAt = Math.min(started.expiresAt, Date.now() + FLOW_TTL_MS);
    if (expiresAt <= Date.now()) throw new Error("Expired before it started");
    const payload: HostedAttempt = {
      companyId: args.companyId,
      userId: args.userId,
      label: args.label,
      provider: args.provider,
      scopeGroups: args.scopeGroups,
      requestedScopes,
      ...(args.extraFields && Object.keys(args.extraFields).length > 0
        ? { extraFields: args.extraFields }
        : {}),
      tokenBrokerUrl: issuer,
      tokenBrokerPath: offer.path,
      requestId: started.requestId,
      codeVerifier,
      existingConnectionId: args.existingConnectionId,
      linkMailbox: args.linkMailbox === true,
    };
    const hostedAttempt = await createAuthFlowState(FLOW_KIND, payload, FLOW_TTL_MS, expiresAt);
    return { authorizeUrl: started.authorizeUrl, hostedAttempt, hostedBrowserProof, expiresAt };
  } catch {
    throw unavailable(hosted.name);
  }
}

function assertOwner(
  snapshot: AuthFlowStateSnapshot<HostedAttempt>,
  args: { companyId: string; userId: string },
): void {
  if (snapshot.payload.companyId !== args.companyId || snapshot.payload.userId !== args.userId) {
    throw new Error("This sign-in belongs to a different Member or company.");
  }
}

export async function cancelHostedOauth(args: {
  companyId: string;
  userId: string;
  attempt: string;
}): Promise<void> {
  // Retry CAS if a concurrent poll just claimed the same pending attempt.
  for (let retry = 0; retry < 4; retry++) {
    const snapshot = await readAuthFlowState<HostedAttempt>(FLOW_KIND, args.attempt);
    if (!snapshot) return;
    assertOwner(snapshot, args);
    if (await consumeAuthFlowStateSnapshot(FLOW_KIND, args.attempt, snapshot)) return;
  }
  throw new Error("Sign-in changed while cancelling. Try again.");
}

export async function pollHostedOauth(args: {
  companyId: string;
  userId: string;
  attempt: string;
}): Promise<HostedOauthPollResult> {
  const snapshot = await readAuthFlowState<HostedAttempt>(FLOW_KIND, args.attempt);
  if (!snapshot) return { status: "denied", detail: RESTART };
  assertOwner(snapshot, args);
  const providerId = snapshot.payload.provider ?? "google";
  const integration = getProvider(providerId);
  const hosted = hostedOauthApp(integration?.catalog.oauth?.app);
  if (!integration?.buildOauthConfig || !hosted) {
    await consumeAuthFlowStateSnapshot(FLOW_KIND, args.attempt, snapshot);
    return { status: "denied", detail: RESTART };
  }
  if (snapshot.payload.pollingUntil) {
    if (snapshot.payload.pollingUntil > Date.now()) return { status: "pending" };
    // A process stopped mid-exchange. Do not redeem a one-use remote result
    // twice or create a second Connection after an ambiguous completion.
    await consumeAuthFlowStateSnapshot(FLOW_KIND, args.attempt, snapshot);
    return { status: "denied", detail: RESTART };
  }
  const claimed = await compareAndSetAuthFlowState(FLOW_KIND, args.attempt, snapshot, {
    ...snapshot.payload,
    pollingUntil: Date.now() + LEASE_MS,
  });
  if (!claimed) return { status: "pending" };
  const lease = await readAuthFlowState<HostedAttempt>(FLOW_KIND, args.attempt);
  if (!lease) return { status: "denied", detail: RESTART };
  let result: z.infer<typeof pollSchema>;
  try {
    result = pollSchema.parse(
      await requestHostedSignIn(
        lease.payload.tokenBrokerUrl,
        hosted.connectProvider,
        lease.payload.tokenBrokerPath ?? LEGACY_GOOGLE_BROKER_PATH,
        "poll",
        { requestId: lease.payload.requestId, codeVerifier: lease.payload.codeVerifier },
      ),
    );
  } catch {
    await compareAndSetAuthFlowState(FLOW_KIND, args.attempt, lease, snapshot.payload);
    throw unavailable(hosted.name);
  }
  if (result.status === "pending") {
    await compareAndSetAuthFlowState(FLOW_KIND, args.attempt, lease, snapshot.payload);
    return { status: "pending" };
  }
  const attempt = await consumeAuthFlowStateSnapshot(FLOW_KIND, args.attempt, lease);
  if (!attempt) return { status: "denied", detail: RESTART };
  if (result.status === "denied") {
    return {
      status: "denied",
      detail: `${hosted.name} sign-in was cancelled or expired. Start again when ready.`,
    };
  }

  const credential = result.credential;
  const scopeGroups = attempt.scopeGroups ?? ["mail"];
  const requestedScopes =
    attempt.requestedScopes ?? integrationOauthScopes(integration, scopeGroups);
  const problem = hosted.credentialProblem({
    credential,
    requestedScopes,
    linkMailbox: attempt.linkMailbox,
  });
  if (problem) return { status: "denied", detail: problem };

  try {
    const built = integration.buildOauthConfig({
      tokens: {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        scope: credential.scope,
        tokenType: "Bearer",
      },
      userInfo: { email: credential.email ?? "" },
      clientId: credential.clientId,
      clientSecret: "",
      scopeGroups,
      extraFields: attempt.extraFields,
    });
    // The client secret stays with the service that issued these tokens.
    const { clientSecret: _secret, ...direct } = built.config as Record<string, unknown>;
    const config = {
      ...direct,
      credentialSource: "hosted",
      tokenBrokerUrl: attempt.tokenBrokerUrl,
      tokenBrokerPath: attempt.tokenBrokerPath ?? LEGACY_GOOGLE_BROKER_PATH,
    } satisfies Partial<HostedOauthCredentials> as unknown as IntegrationConfig;
    await completeOauth({
      companyId: attempt.companyId,
      userId: attempt.userId,
      provider: providerId,
      label: attempt.label,
      existingConnectionId: attempt.existingConnectionId,
      linkMailbox: attempt.linkMailbox,
      config,
      accountHint: credential.email ?? credential.account ?? built.accountHint,
    });
  } catch {
    return {
      status: "denied",
      detail: attempt.linkMailbox
        ? `${hosted.name} sign-in finished, but the mailbox could not be connected. Try again with the same ${hosted.name} account and allow Gmail access.`
        : `${hosted.name} sign-in finished, but the Connection could not be saved. Try again with the same account and allow the access it asks for.`,
    };
  }
  return { status: "complete" };
}
