import crypto from "node:crypto";
import { GOOGLE_SCOPE_GROUPS } from "../integrations/providers/google.js";
import {
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  hasGoogleGmailMailboxScope,
  resolveScopeGroups,
} from "../integrations/providers/google/auth.js";
import {
  compareAndSetAuthFlowState,
  consumeAuthFlowStateSnapshot,
  createAuthFlowState,
  readAuthFlowState,
} from "./authFlowState.js";
import { getRegisteredOauthApp } from "./oauthApps.js";
import { getPublicUrl, normalizePublicUrl } from "./publicUrl.js";
import { getRuntimeOauthSettings, normalizeGmailSignInUrl } from "./runtimeSettings.js";
import { exchangeHostedGoogleCode, refreshHostedGoogleToken } from "./googleSignInGoogle.js";

export const GOOGLE_SIGN_IN_TTL_MS = 10 * 60_000;
const FLOW_KIND = "hosted-google-sign-in";
const CALLBACK_KIND = "hosted-google-sign-in-callback";
const EXPIRED = "This Gmail sign-in expired or was already used. Connect Gmail again.";

export type HostedGoogleCredential = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  email: string;
};

type SignInFlow = {
  codeChallenge: string;
  browserChallenge: string;
  installationOrigin: string;
  clientId: string;
  redirectUri: string;
  status: "pending" | "authorizing" | "denied" | "complete";
  browserNonceHash?: string;
  credential?: HostedGoogleCredential;
  detail?: string;
};

type CallbackFlow = {
  requestId: string;
  browserNonceHash: string;
  googleCodeVerifier: string;
};

export class GoogleSignInBrokerError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "GoogleSignInBrokerError";
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Only displayed to a human: never fetched, followed, or used as a callback. */
export function normalizeGoogleInstallationOrigin(value: string): string {
  try {
    return normalizePublicUrl(value);
  } catch {
    throw new GoogleSignInBrokerError("The installation address must be an HTTP or HTTPS origin.");
  }
}

/** Operator-owned broker origin; independent of customer issuer settings and request Host. */
export function getGoogleSignInBrokerOrigin(): string | null {
  return normalizeGmailSignInUrl(getRuntimeOauthSettings().gmailSignInHostUrl || getPublicUrl());
}

async function brokerConfiguration() {
  if (!getRuntimeOauthSettings().hostGmailSignIn) return null;
  const origin = getGoogleSignInBrokerOrigin();
  if (!origin) return null;
  const credentials = await getRegisteredOauthApp("google");
  return credentials
    ? { ...credentials, origin, redirectUri: `${origin}/api/google-sign-in/callback` }
    : null;
}

async function requireBrokerConfiguration() {
  const config = await brokerConfiguration();
  if (!config) {
    throw new GoogleSignInBrokerError(
      "Hosted Gmail sign-in is unavailable. Please try again later.",
      503,
    );
  }
  return config;
}

export async function getGoogleSignInBrokerStatus() {
  return { version: 1 as const, available: Boolean(await brokerConfiguration()) };
}

export async function startGoogleSignIn(args: {
  codeChallenge: string;
  browserChallenge: string;
  installationOrigin: string;
}) {
  const config = await requireBrokerConfiguration();
  const installationOrigin = normalizeGoogleInstallationOrigin(args.installationOrigin);
  const expiresAt = Date.now() + GOOGLE_SIGN_IN_TTL_MS;
  const requestId = await createAuthFlowState(
    FLOW_KIND,
    {
      codeChallenge: args.codeChallenge,
      browserChallenge: args.browserChallenge,
      installationOrigin,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      status: "pending",
    } satisfies SignInFlow,
    GOOGLE_SIGN_IN_TTL_MS,
    expiresAt,
  );
  return {
    requestId,
    authorizeUrl: `${config.origin}/api/google-sign-in/authorize?requestId=${requestId}`,
    expiresAt,
  };
}

/** The nonce is both an HttpOnly cookie and a form token on this first-party page. */
export async function prepareGoogleSignIn(requestId: string) {
  await requireBrokerConfiguration();
  const state = await readAuthFlowState<SignInFlow>(FLOW_KIND, requestId);
  if (!state || state.payload.status !== "pending") throw new GoogleSignInBrokerError(EXPIRED);
  const browserNonce = crypto.randomBytes(32).toString("base64url");
  if (
    !(await compareAndSetAuthFlowState(FLOW_KIND, requestId, state, {
      ...state.payload,
      browserNonceHash: digest(browserNonce),
    }))
  )
    throw new GoogleSignInBrokerError(EXPIRED);
  return {
    installationOrigin: state.payload.installationOrigin,
    browserNonce,
    expiresAt: state.expiresAt,
  };
}

export async function authorizeGoogleSignIn(args: {
  requestId: string;
  browserNonce: string;
  browserProof: string;
}) {
  const config = await requireBrokerConfiguration();
  const flow = await readAuthFlowState<SignInFlow>(FLOW_KIND, args.requestId);
  if (!flow || flow.payload.status !== "pending") throw new GoogleSignInBrokerError(EXPIRED);
  const browserNonceHash = digest(args.browserNonce);
  if (!flow.payload.browserNonceHash || !equal(browserNonceHash, flow.payload.browserNonceHash)) {
    throw new GoogleSignInBrokerError(
      "Open this Gmail sign-in in the browser where you started it.",
      403,
    );
  }
  if (!equal(digest(args.browserProof), flow.payload.browserChallenge)) {
    throw new GoogleSignInBrokerError(
      "Return to your Genosyn installation and open Connect Gmail again.",
      403,
    );
  }
  if (
    flow.payload.clientId !== config.clientId ||
    flow.payload.redirectUri !== config.redirectUri
  ) {
    throw new GoogleSignInBrokerError("Gmail sign-in settings changed. Connect Gmail again.");
  }
  if (
    !(await compareAndSetAuthFlowState(FLOW_KIND, args.requestId, flow, {
      ...flow.payload,
      status: "authorizing",
    }))
  )
    throw new GoogleSignInBrokerError(EXPIRED);
  const googleCodeVerifier = crypto.randomBytes(32).toString("base64url");
  const state = await createAuthFlowState(
    CALLBACK_KIND,
    {
      requestId: args.requestId,
      browserNonceHash,
      googleCodeVerifier,
    } satisfies CallbackFlow,
    GOOGLE_SIGN_IN_TTL_MS,
    flow.expiresAt,
  );
  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: resolveScopeGroups({
      keys: ["mail"],
      groups: GOOGLE_SCOPE_GROUPS,
      baseline: GOOGLE_OAUTH_IDENTITY_SCOPES,
    }).join(" "),
    access_type: "offline",
    prompt: "consent",
    // A previous grant to another Google product must not widen this Gmail flow.
    include_granted_scopes: "false",
    code_challenge: digest(googleCodeVerifier),
    code_challenge_method: "S256",
    state,
  }).toString();
  return { authorizeUrl: authorizeUrl.toString(), state, expiresAt: flow.expiresAt };
}

export async function completeGoogleSignIn(args: {
  state: string;
  browserNonce: string;
  code?: string;
  error?: string;
}): Promise<{ connected: boolean; detail: string }> {
  const config = await requireBrokerConfiguration();
  const callback = await readAuthFlowState<CallbackFlow>(CALLBACK_KIND, args.state);
  if (!callback) throw new GoogleSignInBrokerError(EXPIRED);
  if (!equal(digest(args.browserNonce), callback.payload.browserNonceHash)) {
    throw new GoogleSignInBrokerError(
      "Open this Gmail sign-in in the browser where you started it.",
      403,
    );
  }
  // Prove the browser binding before burning the callback. Concurrent callbacks
  // cannot exchange the code twice or overwrite a previously completed flow.
  if (!(await consumeAuthFlowStateSnapshot(CALLBACK_KIND, args.state, callback))) {
    throw new GoogleSignInBrokerError(EXPIRED);
  }
  const flow = await readAuthFlowState<SignInFlow>(FLOW_KIND, callback.payload.requestId);
  if (!flow || flow.payload.status !== "authorizing") throw new GoogleSignInBrokerError(EXPIRED);
  let credential: HostedGoogleCredential | undefined;
  let detail = "Gmail sign-in was cancelled. Return to your installation to try again.";
  if (!args.error && args.code) {
    try {
      if (
        config.clientId !== flow.payload.clientId ||
        config.redirectUri !== flow.payload.redirectUri
      ) {
        throw new Error("Changed registration");
      }
      const tokens = await exchangeHostedGoogleCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code: args.code,
        codeVerifier: callback.payload.googleCodeVerifier,
        redirectUri: flow.payload.redirectUri,
      });
      if (!tokens.refreshToken || !hasGoogleGmailMailboxScope(tokens.scope)) {
        detail =
          "Google did not grant the access Gmail needs. Connect again and allow Gmail access.";
      } else {
        credential = {
          clientId: config.clientId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope ?? "",
          email: tokens.email,
        };
      }
    } catch {
      detail = "Google sign-in could not be completed. Return to your installation and try again.";
    }
  }
  const next: SignInFlow = credential
    ? { ...flow.payload, status: "complete", credential }
    : { ...flow.payload, status: "denied", detail };
  if (!(await compareAndSetAuthFlowState(FLOW_KIND, callback.payload.requestId, flow, next))) {
    throw new GoogleSignInBrokerError(EXPIRED);
  }
  return credential
    ? {
        connected: true,
        detail: "Gmail sign-in is complete. Return to your installation to finish connecting.",
      }
    : { connected: false, detail };
}

export type GoogleSignInPollResult =
  | { status: "pending" }
  | { status: "denied"; detail: string }
  | { status: "complete"; credential: HostedGoogleCredential };

export async function pollGoogleSignIn(args: {
  requestId: string;
  codeVerifier: string;
}): Promise<GoogleSignInPollResult> {
  await requireBrokerConfiguration();
  const flow = await readAuthFlowState<SignInFlow>(FLOW_KIND, args.requestId);
  if (!flow) return { status: "denied", detail: EXPIRED };
  if (!equal(digest(args.codeVerifier), flow.payload.codeChallenge)) {
    throw new GoogleSignInBrokerError("The Gmail sign-in proof is invalid.", 403);
  }
  if (flow.payload.status === "pending" || flow.payload.status === "authorizing") {
    return { status: "pending" };
  }
  const claimed = await consumeAuthFlowStateSnapshot(FLOW_KIND, args.requestId, flow);
  if (!claimed) return { status: "denied", detail: EXPIRED };
  if (claimed.status === "complete" && claimed.credential) {
    return { status: "complete", credential: claimed.credential };
  }
  return { status: "denied", detail: claimed.detail ?? EXPIRED };
}

export async function refreshGoogleSignIn(args: { clientId: string; refreshToken: string }) {
  const config = await requireBrokerConfiguration();
  if (!equal(args.clientId, config.clientId)) {
    throw new GoogleSignInBrokerError("The Google registration changed. Connect Gmail again.", 401);
  }
  // No token is persisted: the installation retains its encrypted refresh token.
  return refreshHostedGoogleToken({ ...args, clientSecret: config.clientSecret });
}

export function googleSignInCookieName(token: string): string {
  return `genosyn_gmail_${digest(token).slice(0, 24)}`;
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

/** A standalone page excludes all install custom JavaScript and token values. */
export function googleSignInPage(args: {
  detail?: string;
  scriptNonce?: string;
  form?: { requestId: string; browserNonce: string; installationOrigin: string };
}): string {
  const content = args.form
    ? `<p>Connect Gmail to your Genosyn installation:</p><p class="origin">${html(args.form.installationOrigin)}</p><p id="launch-status">Checking that you opened this page from your installation…</p><p>It will receive access to read, draft, send, and organize your Gmail. Genosyn handles sign-in and token renewal; your installation connects directly to Google to access your mailbox.</p><form method="post" action="/api/google-sign-in/authorize"><input type="hidden" name="requestId" value="${html(args.form.requestId)}"><input type="hidden" name="csrfToken" value="${html(args.form.browserNonce)}"><input id="browser-proof" type="hidden" name="browserProof" value=""><button id="continue" type="submit" disabled>Continue with Google</button></form>`
    : `<p>${html(args.detail ?? "Return to your installation to connect Gmail.")}</p>`;
  const launch =
    args.form && args.scriptNonce
      ? `<script nonce="${html(args.scriptNonce)}">(()=>{const requestId=${JSON.stringify(args.form.requestId)},origin=${JSON.stringify(args.form.installationOrigin).replace(/</g, "\\u003c")};const status=document.getElementById("launch-status"),proof=document.getElementById("browser-proof"),button=document.getElementById("continue");const timer=setTimeout(()=>{if(button.disabled)status.textContent="Return to your Genosyn installation and open Connect Gmail again. Keep its window open.";},5000);window.addEventListener("message",event=>{const data=event.data;if(event.source!==window.opener||event.origin!==origin||!data||data.source!=="genosyn-google-sign-in-launch"||data.requestId!==requestId||typeof data.proof!=="string"||!/^[-A-Za-z0-9._~]{43,128}$/.test(data.proof))return;proof.value=data.proof;button.disabled=false;status.textContent="Opened from your Genosyn installation. Continue only if you intended to connect Gmail.";clearTimeout(timer);});if(window.opener)window.opener.postMessage({source:"genosyn-google-sign-in-ready",requestId},origin);})();</script>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Gmail · Genosyn</title><style>body{margin:0;background:#f8fafc;color:#0f172a;font:16px/1.55 system-ui,sans-serif}main{box-sizing:border-box;max-width:560px;margin:10vh auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;background:white}h1{font-size:24px;margin:0 0 20px}p{color:#475569}.origin{overflow-wrap:anywhere;font-weight:600;color:#0f172a}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#0f172a;color:white;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:3px solid #94a3b8;outline-offset:3px}@media(max-width:600px){main{margin:24px 16px;padding:24px}}</style></head><body><main><h1>Connect Gmail</h1>${content}</main>${launch}</body></html>`;
}
