import crypto from "node:crypto";
import { ConnectError, type SignInErrorCode } from "./errors.js";
import { PROTOCOL_VERSION, type Protocol } from "./protocol.js";
import { offeredScopes, type ConnectProvider, type ScopeGroup } from "./providers/types.js";
import { digest, randomToken, safeEqual, type Sealer } from "./secrets.js";
import { createTokens, encryptResult } from "./tokens.js";

export const SIGN_IN_TTL_MS = 10 * 60_000;
const EXPIRED =
  "This sign-in expired or is no longer valid. Start again from your Genosyn installation.";
const WRONG_BROWSER = "Open this sign-in in the browser where you started it.";
const SETTINGS_CHANGED = "Sign-in settings changed. Connect again from your installation.";

export type AccessItem = { label: string; description: string };

function httpOrigin(value: string): URL {
  const url = new URL(value.trim());
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Not an HTTP origin");
  }
  return url;
}

/** Displayed to the person and used as a postMessage target; never fetched. */
export function normalizeInstallationOrigin(value: string): string {
  try {
    const url = httpOrigin(value);
    if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch {
    // Reported below.
  }
  throw new ConnectError("The installation address must be an HTTP or HTTPS origin.");
}

/**
 * Where the browser is sent back with the result: a page of the installation
 * that started the sign-in, never anywhere else. Connect only redirects there;
 * it never fetches it, so a private or `localhost` installation works.
 */
export function normalizeReturnUrl(value: string, installationOrigin: string): string {
  try {
    const url = httpOrigin(value);
    if (url.origin === installationOrigin && !url.hash && url.toString().length <= 512) {
      return url.toString();
    }
  } catch {
    // Reported below.
  }
  throw new ConnectError(
    "The return address must be a page of the installation that started the sign-in.",
  );
}

/**
 * The proof-bound sign-in, independent of any provider, and stateless.
 *
 * 1. `start` — the installation's server registers the hash of a browser proof,
 *    the page to come back to, and a key to encrypt the result to. All of it is
 *    sealed into the request id; nothing is stored.
 * 2. `prepare` — the consent page sets a nonce cookie in the person's browser.
 * 3. `authorize` — that browser proves it was opened by the installation's own
 *    page (the browser proof) and that it loaded this consent page (the nonce,
 *    double-submitted), then leaves for the provider. This service's PKCE
 *    verifier and the nonce's hash ride, sealed, in the provider's `state`.
 * 4. `complete` — the provider returns to the same browser; the code is
 *    exchanged here, where the client secret lives, and the browser is sent
 *    back to the installation with the credential encrypted to its key.
 *
 * Any replica that shares the operator's secret can serve any step. A copied
 * link is useless: it lacks the opener's proof, the browser cookie, or the
 * key, depending on where it is used.
 */
export function createBroker(
  provider: ConnectProvider,
  protocol: Protocol,
  options: { publicUrl: string; sealer: Sealer; now?: () => number },
) {
  if (provider.id !== protocol.providerId) throw new Error("Protocol and provider mismatch");
  const now = options.now ?? Date.now;
  const tokens = createTokens(options.sealer, provider.id, now);
  const redirectUri = `${options.publicUrl}${protocol.basePath}/callback`;
  const identity = new Set(provider.identityScopes);

  function available(): boolean {
    return Boolean(provider.registration) && provider.groups.length > 0;
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

  function resolveScopes(requested: string[]): string[] {
    const offered = new Set(offeredScopes(provider));
    const product = [...new Set(requested)].filter((scope) => !identity.has(scope));
    const missing = product.filter((scope) => !offered.has(scope));
    if (missing.length > 0) {
      const labels = [...new Set(missing.map(labelFor))].join(", ");
      throw new ConnectError(
        `This sign-in service does not offer ${labels}. Register your own OAuth app in your installation to connect it.`,
      );
    }
    if (product.length === 0) throw new ConnectError("Choose at least one product to connect.");
    return [...identity, ...product];
  }

  /** What the consent page lists: the groups the request touches. */
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
      version: PROTOCOL_VERSION,
      available: open,
      scopes: open ? offeredScopes(provider) : [],
    };
  }

  async function start(args: {
    browserChallenge: string;
    installationOrigin: string;
    returnUrl: string;
    state: string;
    resultKey: string;
    scopes: string[];
  }) {
    const { clientId } = registration();
    const installationOrigin = normalizeInstallationOrigin(args.installationOrigin);
    const returnUrl = normalizeReturnUrl(args.returnUrl, installationOrigin);
    const scopes = resolveScopes(args.scopes);
    const expiresAt = now() + SIGN_IN_TTL_MS;
    const requestId = tokens.sealRequest({
      expiresAt,
      browserChallenge: args.browserChallenge,
      installationOrigin,
      returnUrl,
      state: args.state,
      resultKey: args.resultKey,
      scopes,
      clientId,
    });
    return {
      requestId,
      authorizeUrl: `${options.publicUrl}${protocol.basePath}/authorize?requestId=${requestId}`,
      expiresAt,
    };
  }

  async function prepare(requestId: string) {
    registration();
    const request = tokens.openRequest(requestId);
    if (!request) throw new ConnectError(EXPIRED);
    return {
      installationOrigin: request.installationOrigin,
      // Lives only in this browser's cookie and the page's form; reloading the
      // page overwrites the cookie, retiring any older copy of the page.
      browserNonce: randomToken(),
      expiresAt: request.expiresAt,
      access: describeAccess(request.scopes),
    };
  }

  async function authorize(args: {
    requestId: string;
    browserNonce: string;
    browserProof: string;
  }) {
    const { clientId } = registration();
    const request = tokens.openRequest(args.requestId);
    if (!request) throw new ConnectError(EXPIRED);
    if (!safeEqual(digest(args.browserProof), request.browserChallenge)) {
      throw new ConnectError("Return to your Genosyn installation and open sign-in again.", 403);
    }
    if (request.clientId !== clientId) throw new ConnectError(SETTINGS_CHANGED);
    const codeVerifier = randomToken();
    const state = tokens.sealCallback({
      expiresAt: request.expiresAt,
      nonceHash: digest(args.browserNonce),
      codeVerifier,
      clientId,
      returnUrl: request.returnUrl,
      state: request.state,
      resultKey: request.resultKey,
    });
    return {
      authorizeUrl: provider.authorizeUrl({
        clientId,
        redirectUri,
        scopes: request.scopes,
        codeChallenge: digest(codeVerifier),
        state,
      }),
      state,
      expiresAt: request.expiresAt,
    };
  }

  /** Where to send the browser: the installation's page, with the result in the fragment. */
  async function complete(args: {
    state: string;
    browserNonce: string;
    code?: string;
    error?: string;
  }): Promise<{ location: string }> {
    const registered = registration();
    const callback = tokens.openCallback(args.state);
    if (!callback) throw new ConnectError(EXPIRED);
    if (!safeEqual(digest(args.browserNonce), callback.nonceHash)) {
      throw new ConnectError(WRONG_BROWSER, 403);
    }
    let outcome: { result: string } | { error: SignInErrorCode };
    if (args.error || !args.code) {
      outcome = { error: "access_denied" };
    } else if (callback.clientId !== registered.clientId) {
      outcome = { error: "registration_changed" };
    } else {
      try {
        const credential = await provider.exchange({
          ...registered,
          code: args.code,
          codeVerifier: callback.codeVerifier,
          redirectUri,
        });
        outcome = {
          result: encryptResult(
            callback.resultKey,
            provider.id,
            callback.state,
            JSON.stringify(credential),
          ),
        };
      } catch (error) {
        outcome = {
          error: error instanceof ConnectError && error.code ? error.code : "exchange_failed",
        };
      }
    }
    // The fragment never reaches a server: not the installation's, not a
    // proxy's log. The installation's page reads it and posts it home.
    const fragment = new URLSearchParams({ state: callback.state, ...outcome });
    return { location: `${callback.returnUrl}#${fragment}` };
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
    refresh,
    cookieName,
  };
}

export type Broker = ReturnType<typeof createBroker>;
