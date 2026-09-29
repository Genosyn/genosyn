import crypto from "node:crypto";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowStateSnapshot,
  createAuthFlowState,
  readAuthFlowState,
} from "./authFlowState.js";
import { getPublicUrl, normalizePublicUrl } from "./publicUrl.js";
import { getRuntimeOauthSettings, normalizeSignInUrl } from "./runtimeSettings.js";
import type { SignInBrokerProtocol } from "./signInBrokerProtocol.js";
import {
  SignInBrokerError,
  type HostedSignInCredential,
  type SignInProvider,
} from "./signInBrokerTypes.js";

export { SignInBrokerError } from "./signInBrokerTypes.js";
export const SIGN_IN_TTL_MS = 10 * 60_000;
const EXPIRED = "This sign-in expired or was already used. Connect again from your installation.";

type Binding = { provider?: string; brokerPath?: string };
type SignInFlow = Binding & {
  codeChallenge: string;
  browserChallenge: string;
  installationOrigin: string;
  clientId: string;
  redirectUri: string;
  status: "pending" | "authorizing" | "denied" | "complete";
  browserNonceHash?: string;
  credential?: HostedSignInCredential;
  detail?: string;
};
type CallbackFlow = Binding & {
  requestId: string;
  browserNonceHash: string;
  codeVerifier?: string;
  /** Released Google callbacks already store this field. */
  googleCodeVerifier?: string;
};
export type SignInPollResult =
  | { status: "pending" }
  | { status: "denied"; detail: string }
  | { status: "complete"; credential: HostedSignInCredential };

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Displayed to the human; never fetched or used as a callback destination. */
export function normalizeSignInInstallationOrigin(value: string): string {
  try {
    return normalizePublicUrl(value);
  } catch {
    throw new SignInBrokerError("The installation address must be an HTTP or HTTPS origin.");
  }
}

/** The operator owns this origin; request Host and consumer settings cannot change it. */
export function getSignInBrokerOrigin(): string | null {
  return normalizeSignInUrl(getRuntimeOauthSettings().signInHostUrl || getPublicUrl());
}

/** Shared proof-bound orchestration. Provider endpoints, scopes and identity stay in adapters. */
export function createSignInBroker(provider: SignInProvider, protocol: SignInBrokerProtocol) {
  if (provider.id !== protocol.providerId) throw new Error("Sign-in protocol provider mismatch");
  const binding: Binding = protocol.legacy
    ? {}
    : { provider: provider.id, brokerPath: protocol.basePath };
  const matches = (value: Binding) =>
    protocol.legacy
      ? (value.provider === undefined || value.provider === provider.id) &&
        (value.brokerPath === undefined || value.brokerPath === protocol.basePath)
      : value.provider === provider.id && value.brokerPath === protocol.basePath;

  async function configuration() {
    if (!getRuntimeOauthSettings().hostSignIn) return null;
    const origin = getSignInBrokerOrigin();
    if (!origin) return null;
    const credentials = await provider.registration();
    return credentials
      ? { ...credentials, origin, redirectUri: `${origin}${protocol.basePath}/callback` }
      : null;
  }
  async function requireConfiguration() {
    const config = await configuration();
    if (!config)
      throw new SignInBrokerError("Hosted sign-in is unavailable. Please try again later.", 503);
    return config;
  }
  async function status() {
    return { version: 1 as const, available: Boolean(await configuration()) };
  }
  async function start(args: {
    codeChallenge: string;
    browserChallenge: string;
    installationOrigin: string;
  }) {
    const config = await requireConfiguration();
    const installationOrigin = normalizeSignInInstallationOrigin(args.installationOrigin);
    const expiresAt = Date.now() + SIGN_IN_TTL_MS;
    const requestId = await createAuthFlowState(
      protocol.flowKind,
      {
        ...binding,
        codeChallenge: args.codeChallenge,
        browserChallenge: args.browserChallenge,
        installationOrigin,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        status: "pending",
      } satisfies SignInFlow,
      SIGN_IN_TTL_MS,
      expiresAt,
    );
    return {
      requestId,
      authorizeUrl: `${config.origin}${protocol.basePath}/authorize?requestId=${requestId}`,
      expiresAt,
    };
  }
  async function prepare(requestId: string) {
    await requireConfiguration();
    const state = await readAuthFlowState<SignInFlow>(protocol.flowKind, requestId);
    if (!state || !matches(state.payload) || state.payload.status !== "pending")
      throw new SignInBrokerError(EXPIRED);
    const browserNonce = crypto.randomBytes(32).toString("base64url");
    if (
      !(await compareAndSetAuthFlowState(protocol.flowKind, requestId, state, {
        ...state.payload,
        browserNonceHash: digest(browserNonce),
      }))
    )
      throw new SignInBrokerError(EXPIRED);
    return {
      installationOrigin: state.payload.installationOrigin,
      browserNonce,
      expiresAt: state.expiresAt,
    };
  }
  async function authorize(args: {
    requestId: string;
    browserNonce: string;
    browserProof: string;
  }) {
    const config = await requireConfiguration();
    const flow = await readAuthFlowState<SignInFlow>(protocol.flowKind, args.requestId);
    if (!flow || !matches(flow.payload) || flow.payload.status !== "pending")
      throw new SignInBrokerError(EXPIRED);
    const browserNonceHash = digest(args.browserNonce);
    if (!flow.payload.browserNonceHash || !equal(browserNonceHash, flow.payload.browserNonceHash)) {
      throw new SignInBrokerError("Open this sign-in in the browser where you started it.", 403);
    }
    if (!equal(digest(args.browserProof), flow.payload.browserChallenge)) {
      throw new SignInBrokerError(
        "Return to your Genosyn installation and open sign-in again.",
        403,
      );
    }
    if (
      flow.payload.clientId !== config.clientId ||
      flow.payload.redirectUri !== config.redirectUri
    ) {
      throw new SignInBrokerError(
        "Sign-in settings changed. Connect again from your installation.",
      );
    }
    if (
      !(await compareAndSetAuthFlowState(protocol.flowKind, args.requestId, flow, {
        ...flow.payload,
        status: "authorizing",
      }))
    )
      throw new SignInBrokerError(EXPIRED);
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const state = await createAuthFlowState(
      protocol.callbackKind,
      {
        ...binding,
        requestId: args.requestId,
        browserNonceHash,
        ...(protocol.legacy ? { googleCodeVerifier: codeVerifier } : { codeVerifier }),
      } satisfies CallbackFlow,
      SIGN_IN_TTL_MS,
      flow.expiresAt,
    );
    const authorizeUrl = provider.authorize({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      codeChallenge: digest(codeVerifier),
      state,
    });
    return { authorizeUrl, state, expiresAt: flow.expiresAt };
  }
  async function complete(args: {
    state: string;
    browserNonce: string;
    code?: string;
    error?: string;
  }) {
    const config = await requireConfiguration();
    const callback = await readAuthFlowState<CallbackFlow>(protocol.callbackKind, args.state);
    if (!callback || !matches(callback.payload)) throw new SignInBrokerError(EXPIRED);
    if (!equal(digest(args.browserNonce), callback.payload.browserNonceHash)) {
      throw new SignInBrokerError("Open this sign-in in the browser where you started it.", 403);
    }
    const codeVerifier = protocol.legacy
      ? callback.payload.googleCodeVerifier
      : callback.payload.codeVerifier;
    if (!codeVerifier) throw new SignInBrokerError(EXPIRED);
    // Wrong origins, cookies and protocol bindings cannot burn someone else's callback.
    if (!(await consumeAuthFlowStateSnapshot(protocol.callbackKind, args.state, callback)))
      throw new SignInBrokerError(EXPIRED);
    const flow = await readAuthFlowState<SignInFlow>(protocol.flowKind, callback.payload.requestId);
    if (!flow || !matches(flow.payload) || flow.payload.status !== "authorizing")
      throw new SignInBrokerError(EXPIRED);
    let credential: HostedSignInCredential | undefined;
    let detail = provider.messages.cancelled;
    if (!args.error && args.code) {
      try {
        if (
          config.clientId !== flow.payload.clientId ||
          config.redirectUri !== flow.payload.redirectUri
        )
          throw new Error("Changed registration");
        credential = await provider.exchange({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          code: args.code,
          codeVerifier,
          redirectUri: flow.payload.redirectUri,
        });
      } catch (error) {
        detail = error instanceof SignInBrokerError ? error.message : provider.messages.failed;
      }
    }
    const next: SignInFlow = credential
      ? { ...flow.payload, status: "complete", credential }
      : { ...flow.payload, status: "denied", detail };
    if (
      !(await compareAndSetAuthFlowState(protocol.flowKind, callback.payload.requestId, flow, next))
    )
      throw new SignInBrokerError(EXPIRED);
    return credential
      ? { connected: true, detail: provider.messages.completed }
      : { connected: false, detail };
  }
  async function poll(args: {
    requestId: string;
    codeVerifier: string;
  }): Promise<SignInPollResult> {
    await requireConfiguration();
    const flow = await readAuthFlowState<SignInFlow>(protocol.flowKind, args.requestId);
    if (!flow || !matches(flow.payload)) return { status: "denied", detail: EXPIRED };
    if (!equal(digest(args.codeVerifier), flow.payload.codeChallenge))
      throw new SignInBrokerError("The sign-in proof is invalid.", 403);
    if (flow.payload.status === "pending" || flow.payload.status === "authorizing")
      return { status: "pending" };
    const claimed = await consumeAuthFlowStateSnapshot(protocol.flowKind, args.requestId, flow);
    if (!claimed) return { status: "denied", detail: EXPIRED };
    if (claimed.status === "complete" && claimed.credential)
      return { status: "complete", credential: claimed.credential };
    return { status: "denied", detail: claimed.detail ?? EXPIRED };
  }
  async function refresh(args: { clientId: string; refreshToken: string }) {
    const config = await requireConfiguration();
    if (!equal(args.clientId, config.clientId))
      throw new SignInBrokerError("The sign-in registration changed. Connect again.", 401);
    return provider.refresh({ ...args, clientSecret: config.clientSecret });
  }
  function cookieName(token: string) {
    return `${protocol.cookiePrefix}${digest(token).slice(0, 24)}`;
  }
  return {
    provider,
    protocol,
    status,
    start,
    prepare,
    authorize,
    complete,
    poll,
    refresh,
    cookieName,
  };
}

export type SignInBroker = ReturnType<typeof createSignInBroker>;
