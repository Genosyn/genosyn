import crypto from "node:crypto";
import { ConnectError } from "./errors.js";
import type { FlowStates } from "./flowState.js";
import type { Protocol } from "./protocol.js";
import {
  offeredScopes,
  type ConnectProvider,
  type ProviderCredential,
  type ScopeGroup,
} from "./providers/types.js";
import { digest, randomToken, safeEqual } from "./secrets.js";

export const SIGN_IN_TTL_MS = 10 * 60_000;
const EXPIRED = "This sign-in expired or was already used. Connect again from your installation.";
const WRONG_BROWSER = "Open this sign-in in the browser where you started it.";

type SignInFlow = {
  codeChallenge: string;
  browserChallenge: string;
  installationOrigin: string;
  clientId: string;
  redirectUri: string;
  /** Everything requested upstream, identity scopes first. */
  scopes: string[];
  /** The client named no scopes and expects the provider's original default. */
  defaultRequest: boolean;
  status: "pending" | "authorizing" | "denied" | "complete";
  browserNonceHash?: string;
  credential?: ProviderCredential;
  detail?: string;
};

type CallbackFlow = {
  requestId: string;
  browserNonceHash: string;
  codeVerifier: string;
};

export type PollResult =
  | { status: "pending" }
  | { status: "denied"; detail: string }
  | { status: "complete"; credential: ProviderCredential };

export type AccessItem = { label: string; description: string };

/** Displayed to the person and used as a postMessage target; never fetched. */
export function normalizeInstallationOrigin(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    ) {
      return url.origin;
    }
  } catch {
    // Reported below.
  }
  throw new ConnectError("The installation address must be an HTTP or HTTPS origin.");
}

/**
 * The proof-bound sign-in, independent of any provider.
 *
 * 1. `start` — the installation's server registers a PKCE-style challenge for
 *    collecting the result and a second challenge for its browser.
 * 2. `prepare` — the consent page sets a cookie in the person's browser.
 * 3. `authorize` — that browser proves it was opened by the installation's
 *    page (the browser proof) and from this page (the cookie), then leaves for
 *    the provider with this service's own PKCE verifier.
 * 4. `complete` — the provider returns to the same browser; the code is
 *    exchanged here, where the client secret lives.
 * 5. `poll` — only the installation's server, holding the first verifier,
 *    can collect the credential, exactly once.
 *
 * A link copied out of the flow is useless: it lacks the opener's proof, the
 * browser cookie, or the server-held verifier, depending on where it is used.
 */
export function createBroker(
  provider: ConnectProvider,
  protocol: Protocol,
  options: { publicUrl: string; flows: FlowStates; now?: () => number },
) {
  if (provider.id !== protocol.providerId) throw new Error("Protocol and provider mismatch");
  const { flows } = options;
  const now = options.now ?? Date.now;
  const redirectUri = `${options.publicUrl}${protocol.basePath}/callback`;
  const identity = new Set(provider.identityScopes);
  const defaultGroup = provider.defaultRequest
    ? provider.groups.find((group) => group.key === provider.defaultRequest!.group)
    : undefined;

  function available(): boolean {
    if (!provider.registration) return false;
    return protocol.legacy ? Boolean(defaultGroup) : provider.groups.length > 0;
  }

  function registration() {
    if (!available() || !provider.registration) {
      throw new ConnectError("Hosted sign-in is unavailable. Please try again later.", 503);
    }
    return provider.registration;
  }

  function labelFor(scope: string): string {
    return provider.catalog.find((group) => group.scopes.includes(scope))?.label ?? scope;
  }

  function resolveScopes(requested: string[] | undefined) {
    if (requested === undefined) {
      if (!defaultGroup) {
        const name = provider.defaultRequest
          ? (provider.catalog.find((group) => group.key === provider.defaultRequest!.group)
              ?.label ?? provider.name)
          : provider.name;
        throw new ConnectError(`This sign-in service does not offer ${name}.`);
      }
      return { scopes: [...identity, ...defaultGroup.scopes], defaultRequest: true };
    }
    const offered = new Set(offeredScopes(provider));
    const product = [...new Set(requested)].filter((scope) => !identity.has(scope));
    const missing = product.filter((scope) => !offered.has(scope));
    if (missing.length > 0) {
      const labels = [...new Set(missing.map(labelFor))].join(", ");
      throw new ConnectError(
        `This sign-in service does not offer ${labels}. Register your own OAuth app in your installation to connect it.`,
      );
    }
    if (product.length === 0) {
      throw new ConnectError("Choose at least one product to connect.");
    }
    return { scopes: [...identity, ...product], defaultRequest: false };
  }

  /** What the consent page lists: the offered groups the request touches. */
  function describeAccess(scopes: readonly string[]): AccessItem[] {
    const requested = new Set(scopes);
    const groups: ScopeGroup[] = provider.catalog.filter((group) =>
      group.scopes.some((scope) => requested.has(scope)),
    );
    return groups.map(({ label, description }) => ({ label, description }));
  }

  async function status() {
    const open = available();
    return {
      version: 1 as const,
      available: open,
      scopes: open ? (protocol.legacy ? [...defaultGroup!.scopes] : offeredScopes(provider)) : [],
    };
  }

  async function start(args: {
    codeChallenge: string;
    browserChallenge: string;
    installationOrigin: string;
    scopes?: string[];
  }) {
    const { clientId } = registration();
    const installationOrigin = normalizeInstallationOrigin(args.installationOrigin);
    const { scopes, defaultRequest } = resolveScopes(args.scopes);
    const expiresAt = now() + SIGN_IN_TTL_MS;
    const requestId = await flows.create<SignInFlow>(
      protocol.flowKind,
      {
        codeChallenge: args.codeChallenge,
        browserChallenge: args.browserChallenge,
        installationOrigin,
        clientId,
        redirectUri,
        scopes,
        defaultRequest,
        status: "pending",
      },
      expiresAt,
    );
    return {
      requestId,
      authorizeUrl: `${options.publicUrl}${protocol.basePath}/authorize?requestId=${requestId}`,
      expiresAt,
    };
  }

  async function prepare(requestId: string) {
    registration();
    const flow = await flows.read<SignInFlow>(protocol.flowKind, requestId);
    if (!flow || flow.payload.status !== "pending") throw new ConnectError(EXPIRED);
    const browserNonce = randomToken();
    // Reloading the page issues a new nonce; only the newest page can continue.
    if (
      !(await flows.replace(protocol.flowKind, requestId, flow, {
        ...flow.payload,
        browserNonceHash: digest(browserNonce),
      }))
    ) {
      throw new ConnectError(EXPIRED);
    }
    return {
      installationOrigin: flow.payload.installationOrigin,
      browserNonce,
      expiresAt: flow.expiresAt,
      access: describeAccess(flow.payload.scopes),
    };
  }

  async function authorize(args: {
    requestId: string;
    browserNonce: string;
    browserProof: string;
  }) {
    const { clientId } = registration();
    const flow = await flows.read<SignInFlow>(protocol.flowKind, args.requestId);
    if (!flow || flow.payload.status !== "pending") throw new ConnectError(EXPIRED);
    const browserNonceHash = digest(args.browserNonce);
    if (
      !flow.payload.browserNonceHash ||
      !safeEqual(browserNonceHash, flow.payload.browserNonceHash)
    ) {
      throw new ConnectError(WRONG_BROWSER, 403);
    }
    if (!safeEqual(digest(args.browserProof), flow.payload.browserChallenge)) {
      throw new ConnectError("Return to your Genosyn installation and open sign-in again.", 403);
    }
    if (flow.payload.clientId !== clientId || flow.payload.redirectUri !== redirectUri) {
      throw new ConnectError("Sign-in settings changed. Connect again from your installation.");
    }
    if (
      !(await flows.replace(protocol.flowKind, args.requestId, flow, {
        ...flow.payload,
        status: "authorizing",
      }))
    ) {
      throw new ConnectError(EXPIRED);
    }
    const codeVerifier = randomToken();
    const state = await flows.create<CallbackFlow>(
      protocol.callbackKind,
      { requestId: args.requestId, browserNonceHash, codeVerifier },
      flow.expiresAt,
    );
    return {
      authorizeUrl: provider.authorizeUrl({
        clientId,
        redirectUri,
        scopes: flow.payload.scopes,
        codeChallenge: digest(codeVerifier),
        state,
      }),
      state,
      expiresAt: flow.expiresAt,
    };
  }

  async function complete(args: {
    state: string;
    browserNonce: string;
    code?: string;
    error?: string;
  }) {
    const registered = registration();
    const callback = await flows.read<CallbackFlow>(protocol.callbackKind, args.state);
    if (!callback) throw new ConnectError(EXPIRED);
    // Checked before consuming, so a request from another browser cannot burn
    // the callback that belongs to the person actually signing in.
    if (!safeEqual(digest(args.browserNonce), callback.payload.browserNonceHash)) {
      throw new ConnectError(WRONG_BROWSER, 403);
    }
    if (!(await flows.consume(protocol.callbackKind, args.state, callback))) {
      throw new ConnectError(EXPIRED);
    }
    const flow = await flows.read<SignInFlow>(protocol.flowKind, callback.payload.requestId);
    if (!flow || flow.payload.status !== "authorizing") throw new ConnectError(EXPIRED);

    let credential: ProviderCredential | undefined;
    let detail = provider.messages.cancelled;
    if (!args.error && args.code) {
      try {
        if (
          registered.clientId !== flow.payload.clientId ||
          redirectUri !== flow.payload.redirectUri
        ) {
          throw new ConnectError("Sign-in settings changed. Connect again from your installation.");
        }
        credential = await provider.exchange({
          ...registered,
          code: args.code,
          codeVerifier: callback.payload.codeVerifier,
          redirectUri: flow.payload.redirectUri,
        });
        const granted = credential.scope.split(/\s+/).filter(Boolean);
        if (
          flow.payload.defaultRequest &&
          (!provider.defaultRequest?.satisfiedBy(granted) ||
            !credential.refreshToken ||
            !credential.expiresAt ||
            !credential.email)
        ) {
          credential = undefined;
          detail = provider.defaultRequest?.missingMessage ?? provider.messages.failed;
        }
      } catch (error) {
        credential = undefined;
        detail = error instanceof ConnectError ? error.message : provider.messages.failed;
      }
    }
    const next: SignInFlow = credential
      ? { ...flow.payload, status: "complete", credential }
      : { ...flow.payload, status: "denied", detail };
    if (!(await flows.replace(protocol.flowKind, callback.payload.requestId, flow, next))) {
      throw new ConnectError(EXPIRED);
    }
    return credential
      ? { connected: true, detail: provider.messages.completed }
      : { connected: false, detail };
  }

  async function poll(args: { requestId: string; codeVerifier: string }): Promise<PollResult> {
    registration();
    const flow = await flows.read<SignInFlow>(protocol.flowKind, args.requestId);
    if (!flow) return { status: "denied", detail: EXPIRED };
    if (!safeEqual(digest(args.codeVerifier), flow.payload.codeChallenge)) {
      throw new ConnectError("The sign-in proof is invalid.", 403);
    }
    if (flow.payload.status === "pending" || flow.payload.status === "authorizing") {
      return { status: "pending" };
    }
    const claimed = await flows.consume(protocol.flowKind, args.requestId, flow);
    if (!claimed) return { status: "denied", detail: EXPIRED };
    if (claimed.status === "complete" && claimed.credential) {
      return { status: "complete", credential: claimed.credential };
    }
    return { status: "denied", detail: claimed.detail ?? EXPIRED };
  }

  async function refresh(args: { clientId: string; refreshToken: string }) {
    if (!provider.registration) {
      throw new ConnectError("Hosted sign-in is unavailable. Please try again later.", 503);
    }
    // Renewal must keep working for Connections already issued, even after the
    // operator stops offering their product to new sign-ins.
    const registered = provider.registration;
    if (!safeEqual(args.clientId, registered.clientId)) {
      throw new ConnectError("The sign-in registration changed. Connect again.", 401);
    }
    return provider.refresh({ ...registered, refreshToken: args.refreshToken });
  }

  function cookieName(token: string): string {
    return `${protocol.cookiePrefix}${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
  }

  return {
    provider,
    protocol,
    redirectUri,
    available,
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

export type Broker = ReturnType<typeof createBroker>;
