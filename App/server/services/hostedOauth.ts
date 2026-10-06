import crypto from "node:crypto";
import { z } from "zod";
import { getProvider, listProviderIds } from "../integrations/index.js";
import type { IntegrationConfig } from "../integrations/types.js";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowState,
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
import type { HostedOauthCredentials } from "./hostedOauthTokens.js";
import {
  discoverHostedSignIn,
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
 * Connect keeps no state. This installation's server starts a sign-in with
 * the hash of a browser proof, the page to come back to, and a one-time key;
 * the person's browser completes consent on the service, and the service
 * sends the browser back here with the credential encrypted to that key. Only
 * this server can read it, and the service never needs to reach this
 * installation, so a laptop on `localhost` works the same as a public server.
 * From then on the installation talks to the provider directly; only token
 * renewal goes back to the service that issued the Connection.
 */

const ATTEMPT_KIND = "hosted-oauth-attempt";
const FLOW_TTL_MS = 10 * 60_000;
/** How long completing a returned sign-in may take before a poll gives up on it. */
const COMPLETION_LEASE_MS = 2 * 60_000;
const RESTART = "This sign-in expired or was already used. Start again.";

/** The installation's page Genosyn Connect sends the browser back to. */
const HOSTED_RETURN_PATH = "/api/integrations/oauth/hosted/return";

const startedSchema = z.object({
  requestId: z.string().min(1).max(8192),
  authorizeUrl: z.string().url().max(16_384),
  expiresAt: z.number().finite().positive(),
});
const credentialSchema = z.object({
  clientId: z.string().min(1).max(512),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  expiresAt: z.number().finite().positive().optional(),
  scope: z.string().max(8192),
  email: z.string().email().max(320).optional(),
  account: z.string().min(1).max(320).optional(),
});

type HostedOutcome = { status: "complete" | "denied"; detail?: string };

type HostedAttempt = {
  companyId: string;
  userId: string;
  label: string;
  /** Integration id. */
  provider: string;
  scopeGroups: string[];
  requestedScopes: string[];
  extraFields?: Record<string, string>;
  tokenBrokerUrl: string;
  tokenBrokerPath: string;
  /** The origin the sign-in started from; only its own page may finish it. */
  installationOrigin: string;
  /** Sent to the service once, which encrypts the credential to it; never to a browser. */
  resultKey: string;
  existingConnectionId?: string;
  linkMailbox: boolean;
  /** When the browser came back and this installation began completing it. */
  returnedAt?: number;
  /** What the opener's next poll reports, once. */
  outcome?: HostedOutcome;
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

function offeredScopes(offer: HostedSignInOffer): ReadonlySet<string> {
  return new Set(offer.scopes);
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
    return { status: "available", issuer, offer, scopes: offeredScopes(offer) };
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
  /** Reconnects stay with the service that issued the Connection. */
  tokenBrokerUrl?: string;
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
    // Discovery never sends a credential. A reconnect asks the service that
    // issued the Connection, whatever the installation's current default is.
    offer = await discoverHostedSignIn(issuer, hosted.connectProvider);
  } catch {
    throw unavailable(hosted.name);
  }
  if (!offer) throw unavailable(hosted.name);
  const offered = offeredScopes(offer);
  const missing = product.filter((scope) => !offered.has(scope));
  if (missing.length > 0) {
    throw new Error(
      `Genosyn Connect does not offer ${scopeGroupLabels(integration, missing)} for ${hosted.name}. Choose only what it offers, or use your own OAuth client for the rest.`,
    );
  }

  // The browser proof binds the service's consent page to the browser that is
  // actually visiting this installation. It cannot read the result: only the
  // result key can, and that stays on this server.
  const hostedBrowserProof = crypto.randomBytes(32).toString("base64url");
  const browserChallenge = crypto
    .createHash("sha256")
    .update(hostedBrowserProof)
    .digest("base64url");
  const resultKey = crypto.randomBytes(32).toString("base64url");
  let installationOrigin: string;
  try {
    installationOrigin = new URL(args.installationOrigin ?? getPublicUrl()).origin;
  } catch {
    throw unavailable(hosted.name);
  }
  const deadline = Date.now() + FLOW_TTL_MS;
  let hostedAttempt: string | null = null;
  try {
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
      installationOrigin,
      resultKey,
      existingConnectionId: args.existingConnectionId,
      linkMailbox: args.linkMailbox === true,
    };
    // The attempt's own token is the `state` the service echoes back: it finds
    // this attempt when the browser returns, and binds the encrypted result to it.
    hostedAttempt = await createAuthFlowState(ATTEMPT_KIND, payload, FLOW_TTL_MS, deadline);
    const started = startedSchema.parse(
      await requestHostedSignIn(issuer, hosted.connectProvider, offer.path, "start", {
        browserChallenge,
        installationOrigin,
        returnUrl: `${installationOrigin}${HOSTED_RETURN_PATH}`,
        state: hostedAttempt,
        resultKey,
        scopes: requestedScopes,
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
    const expiresAt = Math.min(started.expiresAt, deadline);
    if (expiresAt <= Date.now()) throw new Error("Expired before it started");
    return { authorizeUrl: started.authorizeUrl, hostedAttempt, hostedBrowserProof, expiresAt };
  } catch {
    if (hostedAttempt) await consumeAuthFlowState(ATTEMPT_KIND, hostedAttempt).catch(() => null);
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
  // Retry CAS if the returning browser just changed the same attempt.
  for (let retry = 0; retry < 4; retry++) {
    const snapshot = await readAuthFlowState<HostedAttempt>(ATTEMPT_KIND, args.attempt);
    if (!snapshot) return;
    assertOwner(snapshot, args);
    if (await consumeAuthFlowStateSnapshot(ATTEMPT_KIND, args.attempt, snapshot)) return;
  }
  throw new Error("Sign-in changed while cancelling. Try again.");
}

/**
 * The opener's view of a sign-in: pending until the browser returns from the
 * service and this installation has finished with it, then its outcome, once.
 * Nothing here contacts the service.
 */
export async function pollHostedOauth(args: {
  companyId: string;
  userId: string;
  attempt: string;
}): Promise<HostedOauthPollResult> {
  const snapshot = await readAuthFlowState<HostedAttempt>(ATTEMPT_KIND, args.attempt);
  if (!snapshot) return { status: "denied", detail: RESTART };
  assertOwner(snapshot, args);
  const { outcome, returnedAt } = snapshot.payload;
  if (outcome) {
    await consumeAuthFlowStateSnapshot(ATTEMPT_KIND, args.attempt, snapshot);
    return outcome;
  }
  if (returnedAt !== undefined && returnedAt + COMPLETION_LEASE_MS <= Date.now()) {
    // The process completing it stopped midway. Never guess whether a
    // Connection was saved; ask for a fresh sign-in instead.
    await consumeAuthFlowStateSnapshot(ATTEMPT_KIND, args.attempt, snapshot);
    return { status: "denied", detail: RESTART };
  }
  return { status: "pending" };
}

/** The browser that came back is not this installation's own page. */
export class HostedReturnOriginError extends Error {
  constructor() {
    super("This sign-in can only finish on the Genosyn page that started it.");
    this.name = "HostedReturnOriginError";
  }
}

const RESULT_PATTERN = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,65536}$/;

/**
 * The installation's side of Genosyn Connect's result encryption: AES-256-GCM
 * under the attempt's key, bound to the service's provider id and the
 * attempt's `state`, formatted `<iv>.<ciphertext and tag>` in base64url.
 * Null for anything not sealed to this attempt.
 */
export function decryptHostedResult(
  resultKey: string,
  provider: string,
  state: string,
  sealed: string,
): string | null {
  if (!RESULT_PATTERN.test(sealed)) return null;
  const [ivText, payloadText] = sealed.split(".");
  try {
    const key = Buffer.from(resultKey, "base64url");
    const iv = Buffer.from(ivText, "base64url");
    const payload = Buffer.from(payloadText, "base64url");
    if (key.length !== 32 || iv.length !== 12 || payload.length < 17) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`genosyn-connect-result:v2:${provider}:${state}`));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    return Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Why the service says a sign-in ended without a credential, in this installation's words. */
function returnedErrorDetail(hosted: HostedOauthApp, code: string): string {
  switch (code) {
    case "access_denied":
      return `${hosted.name} sign-in was cancelled. Start again when ready.`;
    case "account_unverified":
      return `${hosted.name} did not confirm a verified email address for this account. Try another account.`;
    case "offline_access_missing":
      return `${hosted.name} did not grant lasting access. Start again and allow access on the consent screen.`;
    case "registration_changed":
      return "Genosyn Connect's sign-in settings changed while you were signing in. Start again.";
    default:
      return `${hosted.name} sign-in could not be completed. Start again.`;
  }
}

/**
 * The browser is back from Genosyn Connect: decrypt the credential with the
 * attempt's key, save the Connection, and leave the outcome for the opener's
 * next poll. Each attempt finishes once; a replay, or a return after the
 * Member cancelled, finds nothing to finish.
 */
export async function completeHostedReturn(args: {
  state: string;
  result?: string;
  error?: string;
  /** The `Origin` of the page that posted the return. */
  origin: string | undefined;
}): Promise<HostedOutcome> {
  const snapshot = await readAuthFlowState<HostedAttempt>(ATTEMPT_KIND, args.state);
  if (!snapshot || snapshot.payload.returnedAt !== undefined) {
    return { status: "denied", detail: RESTART };
  }
  if (args.origin !== snapshot.payload.installationOrigin) throw new HostedReturnOriginError();
  const claimed = await compareAndSetAuthFlowState(ATTEMPT_KIND, args.state, snapshot, {
    ...snapshot.payload,
    returnedAt: Date.now(),
  });
  if (!claimed) return { status: "denied", detail: RESTART };
  const lease = await readAuthFlowState<HostedAttempt>(ATTEMPT_KIND, args.state);
  if (!lease) return { status: "denied", detail: RESTART };
  const outcome = await finishReturnedSignIn(lease.payload, args);
  // A Member who cancelled meanwhile no longer waits for this outcome.
  await compareAndSetAuthFlowState(ATTEMPT_KIND, args.state, lease, {
    ...lease.payload,
    outcome,
  });
  return outcome;
}

async function finishReturnedSignIn(
  attempt: HostedAttempt,
  args: { state: string; result?: string; error?: string },
): Promise<HostedOutcome> {
  const integration = getProvider(attempt.provider);
  const hosted = hostedOauthApp(integration?.catalog.oauth?.app);
  if (!integration?.buildOauthConfig || !hosted) return { status: "denied", detail: RESTART };
  if (!args.result) {
    return { status: "denied", detail: returnedErrorDetail(hosted, args.error ?? "") };
  }
  const plaintext = decryptHostedResult(
    attempt.resultKey,
    hosted.connectProvider,
    args.state,
    args.result,
  );
  let credential: z.infer<typeof credentialSchema>;
  try {
    credential = credentialSchema.parse(JSON.parse(plaintext ?? "null"));
  } catch {
    // Whatever arrived, its content never reaches the Member.
    return {
      status: "denied",
      detail: `${hosted.name} sign-in could not be verified. Start again.`,
    };
  }

  const problem = hosted.credentialProblem({
    credential,
    requestedScopes: attempt.requestedScopes,
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
      scopeGroups: attempt.scopeGroups,
      extraFields: attempt.extraFields,
    });
    // The client secret stays with the service that issued these tokens.
    const { clientSecret: _secret, ...direct } = built.config as Record<string, unknown>;
    const config = {
      ...direct,
      credentialSource: "hosted",
      tokenBrokerUrl: attempt.tokenBrokerUrl,
      tokenBrokerPath: attempt.tokenBrokerPath,
    } satisfies Partial<HostedOauthCredentials> as unknown as IntegrationConfig;
    await completeOauth({
      companyId: attempt.companyId,
      userId: attempt.userId,
      provider: attempt.provider,
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
