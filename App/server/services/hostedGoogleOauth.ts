import crypto from "node:crypto";
import { z } from "zod";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowStateSnapshot,
  createAuthFlowState,
  readAuthFlowState,
  type AuthFlowStateSnapshot,
} from "./authFlowState.js";
import { getPublicUrl } from "./publicUrl.js";
import { getRuntimeOauthSettings, normalizeGmailSignInUrl } from "./runtimeSettings.js";
import type { GoogleHostedOauthConfig } from "../integrations/providers/google/auth.js";

const FLOW_KIND = "hosted-google-consumer";
const FLOW_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LEASE_MS = 30_000;
const BROKER_PATH = "/api/google-sign-in";
const UNAVAILABLE =
  "Google sign-in is unavailable. Try again later, or ask an instance admin to register a Google OAuth app at Admin → Integrations.";
const RESTART = "This Google sign-in expired or was already used. Start again.";
const availabilityCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

const credentialSchema = z.object({
  clientId: z.string().min(1).max(512),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
  expiresAt: z.number().finite().positive(),
  scope: z.string().max(8192),
  email: z.string().email().max(320),
});
const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied"), detail: z.string().max(2000).optional() }),
  z.object({ status: z.literal("complete"), credential: credentialSchema }),
]);
const refreshSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  expiresAt: z.number().finite().positive(),
  refreshToken: z.string().min(1).max(16_384).optional(),
  scope: z.string().max(8192).optional(),
});

type HostedAttempt = {
  companyId: string;
  userId: string;
  label: string;
  tokenBrokerUrl: string;
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

function brokerUrl(value: string): string {
  const normalized = normalizeGmailSignInUrl(value);
  if (!normalized) throw new Error(UNAVAILABLE);
  return normalized;
}

/** Only the saved issuer ever receives a Connection's refresh token. No
 * redirects, cookie forwarding, provider error body, or browser token path. */
async function requestBroker(
  issuer: string,
  path: string,
  payload?: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetch(`${brokerUrl(issuer)}${BROKER_PATH}${path}`, {
    method: payload ? "POST" : "GET",
    headers: payload
      ? { "content-type": "application/json", accept: "application/json" }
      : { accept: "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(UNAVAILABLE);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(UNAVAILABLE);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 65_536) {
      await reader.cancel();
      throw new Error(UNAVAILABLE);
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** A configured URL is not evidence that a hosted service is operational. */
export async function hostedGoogleSignInAvailable(): Promise<boolean> {
  const settings = getRuntimeOauthSettings();
  if (!settings.gmailSignInEnabled) return false;
  const issuer = normalizeGmailSignInUrl(settings.gmailSignInUrl);
  if (!issuer) return false;
  const cached = availabilityCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = requestBroker(issuer, "/status", undefined, 2000)
    .then(
      (raw) =>
        z.object({ version: z.literal(1), available: z.literal(true) }).safeParse(raw).success,
    )
    .catch(() => false);
  // Bound memory when a master admin changes the configured URL repeatedly.
  availabilityCache.clear();
  availabilityCache.set(issuer, { expiresAt: Date.now() + 30_000, result });
  return result;
}

export function resetHostedGoogleAvailabilityForTests(): void {
  availabilityCache.clear();
}

export async function startHostedGoogleOauth(args: {
  companyId: string;
  userId: string;
  label: string;
  existingConnectionId?: string;
  linkMailbox?: boolean;
  installationOrigin?: string;
  /** Reconnects stay with the issuer that originally issued this grant. */
  tokenBrokerUrl?: string;
}): Promise<OauthStartResult> {
  const settings = getRuntimeOauthSettings();
  if (!settings.gmailSignInEnabled) throw new Error(UNAVAILABLE);
  const issuer = brokerUrl(args.tokenBrokerUrl ?? settings.gmailSignInUrl);
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  // Independent browser proof binds the broker interstitial to the browser
  // actually visiting this installation. It cannot redeem the token result.
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
        await requestBroker(issuer, "/start", {
          codeChallenge,
          browserChallenge,
          installationOrigin: new URL(args.installationOrigin ?? getPublicUrl()).origin,
        }),
      );
    const authorize = new URL(started.authorizeUrl);
    if (authorize.origin !== new URL(issuer).origin || authorize.username || authorize.password) {
      throw new Error(UNAVAILABLE);
    }
    const expiresAt = Math.min(started.expiresAt, Date.now() + FLOW_TTL_MS);
    if (expiresAt <= Date.now()) throw new Error(UNAVAILABLE);
    const payload: HostedAttempt = {
      companyId: args.companyId,
      userId: args.userId,
      label: args.label,
      tokenBrokerUrl: issuer,
      requestId: started.requestId,
      codeVerifier,
      existingConnectionId: args.existingConnectionId,
      linkMailbox: args.linkMailbox === true,
    };
    const hostedAttempt = await createAuthFlowState(FLOW_KIND, payload, FLOW_TTL_MS, expiresAt);
    return { authorizeUrl: started.authorizeUrl, hostedAttempt, hostedBrowserProof, expiresAt };
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

function assertOwner(
  snapshot: AuthFlowStateSnapshot<HostedAttempt>,
  args: { companyId: string; userId: string },
): void {
  if (snapshot.payload.companyId !== args.companyId || snapshot.payload.userId !== args.userId) {
    throw new Error("This Google sign-in belongs to a different Member or company.");
  }
}

export async function cancelHostedGoogleOauth(args: {
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
  throw new Error("Google sign-in changed while cancelling. Try again.");
}

export async function pollHostedGoogleOauth(args: {
  companyId: string;
  userId: string;
  attempt: string;
}): Promise<HostedOauthPollResult> {
  const snapshot = await readAuthFlowState<HostedAttempt>(FLOW_KIND, args.attempt);
  if (!snapshot) return { status: "denied", detail: RESTART };
  assertOwner(snapshot, args);
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
      await requestBroker(lease.payload.tokenBrokerUrl, "/poll", {
        requestId: lease.payload.requestId,
        codeVerifier: lease.payload.codeVerifier,
      }),
    );
  } catch {
    await compareAndSetAuthFlowState(FLOW_KIND, args.attempt, lease, snapshot.payload);
    throw new Error(UNAVAILABLE);
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
      detail: "Google sign-in was cancelled or expired. Start again when ready.",
    };
  }
  const credential = result.credential;
  if (
    !credential.scope.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.modify") ||
    credential.expiresAt <= Date.now()
  ) {
    return {
      status: "denied",
      detail:
        "Google did not grant Gmail access. Start again and allow Gmail access on the consent screen.",
    };
  }
  const config: GoogleHostedOauthConfig = {
    ...credential,
    credentialSource: "hosted",
    tokenBrokerUrl: attempt.tokenBrokerUrl,
    scopeGroups: ["mail"],
  };
  try {
    // This module also supplies Google's refresh transport; import the
    // persistence layer only at completion to avoid a provider-registry cycle.
    const { completeOauth } = await import("./completeOauth.js");
    await completeOauth({
      companyId: attempt.companyId,
      userId: attempt.userId,
      provider: "google",
      label: attempt.label,
      existingConnectionId: attempt.existingConnectionId,
      linkMailbox: attempt.linkMailbox,
      config,
      accountHint: credential.email,
    });
  } catch {
    return {
      status: "denied",
      detail:
        "Google sign-in finished, but the mailbox could not be connected. Try again with the same Google account and allow Gmail access.",
    };
  }
  return { status: "complete" };
}

export async function refreshHostedGoogleToken(
  config: GoogleHostedOauthConfig,
): Promise<GoogleHostedOauthConfig> {
  try {
    const refreshed = refreshSchema.parse(
      await requestBroker(config.tokenBrokerUrl, "/refresh", {
        clientId: config.clientId,
        refreshToken: config.refreshToken,
      }),
    );
    if (refreshed.expiresAt <= Date.now()) throw new Error(UNAVAILABLE);
    return { ...config, ...refreshed };
  } catch {
    throw new Error(
      "Google sign-in could not refresh this Connection. Try again later or reconnect with Google.",
    );
  }
}
