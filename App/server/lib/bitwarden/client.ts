import crypto from "node:crypto";

import { config } from "../../../config.js";
import { assertSafeOutboundUrl } from "../outboundUrl.js";
import { appVersion } from "../version.js";
import { BITWARDEN_KDF_ARGON2ID, BITWARDEN_KDF_PBKDF2, type BitwardenKdf } from "./keys.js";

/**
 * The HTTP half of the Bitwarden vault protocol: enough of `identity` and
 * `api` to log in, read the vault, and read one item back.
 *
 * Three things this module does deliberately, because getting them wrong is
 * either a security hole or an intermittent failure nobody can reproduce:
 *
 *  - **Redirects are refused outright.** The Bitwarden API never redirects, and
 *    following one would hand a bearer token to whatever the redirect named.
 *  - **Every field is read case-insensitively.** `/identity/connect/token`
 *    mixes snake_case OAuth fields with PascalCase Bitwarden fields, `prelogin`
 *    and `/api/sync` are camelCase on current servers and PascalCase on older
 *    ones, and Vaultwarden differs again. The official clients cope with a
 *    case-flipping accessor; so does {@link readField}.
 *  - **The client identity headers are sent in full.** They are not required
 *    for a request to succeed, but the server branches response *shape* on
 *    `Bitwarden-Client-Name` + `Bitwarden-Client-Version`, so omitting them
 *    silently changes what comes back.
 */

/** `DeviceType.SDK` — the honest claim for a server-side integration. */
const BITWARDEN_DEVICE_TYPE = "21";
/**
 * Servers gate parts of their response on the client name and version. `cli`
 * is the closest match to what Genosyn does with the vault (read it headlessly)
 * and is the value third-party clients settled on; the version is a floor that
 * says "new enough for the current response shapes", not a claim to be that
 * release.
 */
const BITWARDEN_CLIENT_NAME = "cli";
const BITWARDEN_CLIENT_VERSION = "2025.8.0";

export class BitwardenApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never completed. */
    readonly status: number,
    /** True when the account needs a second factor the caller has not supplied. */
    readonly twoFactorRequired = false,
  ) {
    super(message);
    this.name = "BitwardenApiError";
  }
}

export type BitwardenEndpoints = {
  identityUrl: string;
  apiUrl: string;
};

const CLOUD_HOSTS: Record<string, BitwardenEndpoints> = {
  "bitwarden.com": {
    identityUrl: "https://identity.bitwarden.com",
    apiUrl: "https://api.bitwarden.com",
  },
  "vault.bitwarden.com": {
    identityUrl: "https://identity.bitwarden.com",
    apiUrl: "https://api.bitwarden.com",
  },
  "bitwarden.eu": {
    identityUrl: "https://identity.bitwarden.eu",
    apiUrl: "https://api.bitwarden.eu",
  },
  "vault.bitwarden.eu": {
    identityUrl: "https://identity.bitwarden.eu",
    apiUrl: "https://api.bitwarden.eu",
  },
};

/**
 * Work out where `identity` and `api` live for a server.
 *
 * A self-hosted install (including Vaultwarden) mounts both under the one web
 * vault URL. Bitwarden's own regions do not — they use sibling hostnames — so
 * those are mapped explicitly rather than guessed.
 */
export function bitwardenEndpoints(serverUrl: string): BitwardenEndpoints {
  const base = normalizeBitwardenServerUrl(serverUrl);
  const host = new URL(base).hostname.toLowerCase();
  const cloud = CLOUD_HOSTS[host];
  if (cloud) return cloud;
  return { identityUrl: `${base}/identity`, apiUrl: `${base}/api` };
}

/** Strip trailing slashes and default a bare host to https, as the CLI does. */
export function normalizeBitwardenServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) throw new BitwardenApiError("A Bitwarden server URL is required", 0);
  // Note the order: trailing slashes come off the parsed pathname below, not
  // off the raw string. Stripping first turns "http://" into "http:", which
  // then reads as a schemeless host and becomes the URL "https://http".
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BitwardenApiError("That Bitwarden server URL could not be read", 0);
  }
  if (url.username || url.password) {
    throw new BitwardenApiError("A Bitwarden server URL must not embed credentials", 0);
  }
  if (url.search || url.hash) {
    throw new BitwardenApiError("A Bitwarden server URL must not carry a query or fragment", 0);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Read a JSON field regardless of how the server capitalized it.
 *
 * Probe order matches the official client's accessor: exact, first character
 * case-flipped, all lower, all upper.
 */
export function readField(source: unknown, name: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  if (record[name] !== undefined) return record[name];
  const flipped =
    name.charAt(0) === name.charAt(0).toUpperCase()
      ? name.charAt(0).toLowerCase() + name.slice(1)
      : name.charAt(0).toUpperCase() + name.slice(1);
  if (record[flipped] !== undefined) return record[flipped];
  if (record[name.toLowerCase()] !== undefined) return record[name.toLowerCase()];
  if (record[name.toUpperCase()] !== undefined) return record[name.toUpperCase()];
  return undefined;
}

export function readStringField(source: unknown, name: string): string | null {
  const value = readField(source, name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumberField(source: unknown, name: string): number | null {
  const value = readField(source, name);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Fetch one Bitwarden endpoint.
 *
 * The SSRF guard is unconditional, as it is on every other outbound surface in
 * this codebase — a custom model's base URL, an MCP server URL, an SSO issuer.
 * It is tempting to relax it for a self-hosted install on the grounds that a
 * company admin there is the operator, but that is not what a company admin is:
 * anyone who can sign in can create a company and own it, so the exemption
 * would hand every signed-in user a scanner pointed at the host's own network.
 *
 * A Vaultwarden on a private address is still reachable — that is what
 * `config.security.outboundPrivateHostAllowlist` is for, and naming one host
 * there is a decision the operator makes once, deliberately, rather than one
 * every tenant inherits.
 */
async function bitwardenFetch(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown; text: string }> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new BitwardenApiError("Only http(s) Bitwarden servers are supported", 0);
  }
  try {
    await assertSafeOutboundUrl(target);
  } catch {
    throw new BitwardenApiError(
      `${target.hostname} is not reachable from Genosyn because it resolves to a private address. Add it to security.outboundPrivateHostAllowlist in the instance configuration to allow it.`,
      0,
    );
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(config.security.outboundRequestTimeoutMs),
    });
  } catch {
    throw new BitwardenApiError(`The Bitwarden server at ${target.origin} could not be reached`, 0);
  }

  let raw: string;
  try {
    raw = await readBoundedText(response);
  } catch (error) {
    if (error instanceof BitwardenApiError) throw error;
    throw new BitwardenApiError(
      `The response from ${target.origin} ended before Genosyn could read it`,
      0,
    );
  }
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text: raw };
}

async function readBoundedText(response: Response): Promise<string> {
  const limit = config.security.outboundMaxResponseBytes;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BitwardenApiError("The Bitwarden server sent more data than Genosyn accepts", 0);
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Device-Type": BITWARDEN_DEVICE_TYPE,
    "Bitwarden-Client-Name": BITWARDEN_CLIENT_NAME,
    "Bitwarden-Client-Version": BITWARDEN_CLIENT_VERSION,
    "User-Agent": `Genosyn/${appVersion()} (SDK)`,
  };
}

/** Ask the server which KDF the account uses before deriving anything. */
export async function bitwardenPrelogin(
  endpoints: BitwardenEndpoints,
  email: string,
): Promise<BitwardenKdf> {
  const { status, json } = await bitwardenFetch(`${endpoints.identityUrl}/accounts/prelogin`, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  if (status !== 200) {
    throw new BitwardenApiError("The Bitwarden server rejected the account lookup", status);
  }
  return readKdf(json);
}

/**
 * Read KDF parameters out of a `prelogin` or token response.
 *
 * Both spell the fields differently by server version, and newer servers nest
 * a second copy under `kdfSettings` / `UserDecryptionOptions`. The flat fields
 * are still populated everywhere, so those are read first.
 */
export function readKdf(source: unknown): BitwardenKdf {
  const nested = readField(source, "kdfSettings");
  const kindRaw =
    readNumberField(source, "kdf") ??
    readNumberField(nested, "kdfType") ??
    readNumberField(nested, "kdf");
  const iterations =
    readNumberField(source, "kdfIterations") ?? readNumberField(nested, "iterations");
  const memory = readNumberField(source, "kdfMemory") ?? readNumberField(nested, "memory");
  const parallelism =
    readNumberField(source, "kdfParallelism") ?? readNumberField(nested, "parallelism");
  if (kindRaw !== BITWARDEN_KDF_PBKDF2 && kindRaw !== BITWARDEN_KDF_ARGON2ID) {
    throw new BitwardenApiError("The Bitwarden server reported an unknown password KDF", 0);
  }
  if (iterations === null) {
    throw new BitwardenApiError("The Bitwarden server did not report its KDF iterations", 0);
  }
  return { kind: kindRaw, iterations, memory, parallelism };
}

export type BitwardenLoginRequest = {
  endpoints: BitwardenEndpoints;
  email: string;
  /** The derived hash, never the typed password. */
  masterPasswordHash: string;
  deviceIdentifier: string;
  /** Personal API key. When present it is used instead of the password grant. */
  clientId?: string | null;
  clientSecret?: string | null;
  /** A freshly typed authenticator code, for a first login on a 2FA account. */
  twoFactorCode?: string | null;
  /** A remembered second factor from an earlier login. */
  twoFactorToken?: string | null;
};

export type BitwardenSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  /** Returned when the server honored `twoFactorRemember`; worth persisting. */
  twoFactorToken: string | null;
  /** The master-key-wrapped user key, when the server sent one. */
  protectedUserKey: string | null;
  protectedPrivateKey: string | null;
  /** Restated on every login so a client can notice the account's KDF moved. */
  kdf: BitwardenKdf | null;
};

/**
 * Authenticate.
 *
 * An API key (`client_credentials`) is preferred whenever one is configured:
 * it skips two-factor entirely and, on Bitwarden cloud, skips the new-device
 * email verification that would otherwise make a headless login impossible.
 */
export async function bitwardenLogin(request: BitwardenLoginRequest): Promise<BitwardenSession> {
  const usesApiKey = Boolean(request.clientId && request.clientSecret);
  const form = new URLSearchParams();
  form.set("deviceType", BITWARDEN_DEVICE_TYPE);
  form.set("deviceIdentifier", request.deviceIdentifier);
  form.set("deviceName", "genosyn");
  if (usesApiKey) {
    form.set("grant_type", "client_credentials");
    form.set("scope", "api");
    form.set("client_id", request.clientId!);
    form.set("client_secret", request.clientSecret!);
  } else {
    form.set("grant_type", "password");
    form.set("scope", "api offline_access");
    form.set("client_id", "cli");
    form.set("username", request.email);
    form.set("password", request.masterPasswordHash);
  }
  if (!usesApiKey && request.twoFactorCode) {
    form.set("twoFactorProvider", "0");
    form.set("twoFactorToken", request.twoFactorCode);
    form.set("twoFactorRemember", "1");
  } else if (!usesApiKey && request.twoFactorToken) {
    form.set("twoFactorProvider", "5");
    form.set("twoFactorToken", request.twoFactorToken);
    form.set("twoFactorRemember", "0");
  }

  const headers: Record<string, string> = {
    ...baseHeaders(),
    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
  };
  if (!usesApiKey) {
    // Self-hosted servers up to v2025.5 reject a password grant whose
    // `Auth-Email` does not match the username byte for byte. Newer servers
    // and Vaultwarden ignore the header, so sending it is free compatibility.
    headers["Auth-Email"] = Buffer.from(request.email, "utf8").toString("base64url");
  }

  const { status, json } = await bitwardenFetch(`${request.endpoints.identityUrl}/connect/token`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  if (status !== 200) throw loginError(status, json);
  return toSession(json);
}

/** Exchange a stored refresh token for a fresh access token. */
export async function bitwardenRefresh(
  endpoints: BitwardenEndpoints,
  refreshToken: string,
): Promise<BitwardenSession> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", "cli");
  form.set("refresh_token", refreshToken);
  const { status, json } = await bitwardenFetch(`${endpoints.identityUrl}/connect/token`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: form.toString(),
  });
  if (status !== 200) throw loginError(status, json);
  return toSession(json);
}

function toSession(json: unknown): BitwardenSession {
  const accessToken = readStringField(json, "access_token");
  if (!accessToken) {
    throw new BitwardenApiError("The Bitwarden server returned no access token", 0);
  }
  const expiresIn = readNumberField(json, "expires_in") ?? 3600;
  const decryptionOptions = readField(json, "UserDecryptionOptions");
  const masterPasswordUnlock = readField(decryptionOptions, "MasterPasswordUnlock");
  const accountKeys = readField(json, "AccountKeys");
  const keyPair = readField(accountKeys, "publicKeyEncryptionKeyPair");
  let kdf: BitwardenKdf | null = null;
  try {
    kdf = readKdf(json);
  } catch {
    kdf = null;
  }
  return {
    accessToken,
    refreshToken: readStringField(json, "refresh_token"),
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    twoFactorToken: readStringField(json, "TwoFactorToken"),
    protectedUserKey:
      readStringField(json, "Key") ??
      readStringField(masterPasswordUnlock, "MasterKeyWrappedUserKey") ??
      readStringField(masterPasswordUnlock, "MasterKeyEncryptedUserKey"),
    protectedPrivateKey:
      readStringField(json, "PrivateKey") ?? readStringField(keyPair, "wrappedPrivateKey"),
    kdf,
  };
}

/**
 * Fold a server-supplied message down to something safe to store and show.
 *
 * These strings end up on the Vault source row and in front of an admin. The
 * server on the other end is not necessarily Bitwarden — it is whatever answered
 * the configured URL — so its text is untrusted: one line, no control
 * characters, and short enough that it cannot be used to smuggle a page of
 * someone else's response into the UI.
 */
function safeServerMessage(value: string | null): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!flattened) return null;
  return flattened.length > 200 ? `${flattened.slice(0, 197)}…` : flattened;
}

function loginError(status: number, json: unknown): BitwardenApiError {
  const providers = readField(json, "TwoFactorProviders2");
  if (status === 400 && providers && Object.keys(providers as object).length > 0) {
    return new BitwardenApiError(
      "This Bitwarden account requires two-step login. Enter a current authenticator code, or connect with a Bitwarden API key instead.",
      status,
      true,
    );
  }
  const errorModel = readField(json, "ErrorModel");
  const modelMessage = readStringField(errorModel, "Message");
  if (modelMessage && /new device verification/i.test(modelMessage)) {
    return new BitwardenApiError(
      "Bitwarden wants to verify this as a new device. Connect with a Bitwarden API key instead — an API key login is exempt.",
      status,
    );
  }
  const code = readStringField(json, "error");
  if (code === "invalid_client") {
    return new BitwardenApiError("That Bitwarden API key was not accepted", status);
  }
  const described =
    safeServerMessage(readStringField(json, "error_description")) ??
    safeServerMessage(modelMessage);
  return new BitwardenApiError(described ?? "Bitwarden rejected the sign-in", status);
}

async function bitwardenGet(
  endpoints: BitwardenEndpoints,
  accessToken: string,
  path: string,
): Promise<unknown> {
  const { status, json } = await bitwardenFetch(`${endpoints.apiUrl}${path}`, {
    method: "GET",
    headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
  });
  if (status === 401) throw new BitwardenApiError("The Bitwarden session expired", status);
  if (status === 404) throw new BitwardenApiError("That Bitwarden item no longer exists", status);
  if (status === 429) {
    throw new BitwardenApiError("Bitwarden is rate-limiting Genosyn; try again shortly", status);
  }
  if (status !== 200) {
    throw new BitwardenApiError(`Bitwarden returned an unexpected ${status} response`, status);
  }
  return json;
}

/** Read the whole vault. Bitwarden has no incremental endpoint. */
export function bitwardenSync(
  endpoints: BitwardenEndpoints,
  accessToken: string,
): Promise<unknown> {
  return bitwardenGet(endpoints, accessToken, "/sync?excludeDomains=true");
}

/**
 * Read the account profile.
 *
 * This is where the organization keys live. The token response does not carry
 * them, and pulling a whole sync just to unwrap one organization key would be a
 * poor trade on the single-item read path.
 */
export function bitwardenProfile(
  endpoints: BitwardenEndpoints,
  accessToken: string,
): Promise<unknown> {
  return bitwardenGet(endpoints, accessToken, "/accounts/profile");
}

/** Read one item, so resolving a single secret does not pull the whole vault. */
export function bitwardenCipher(
  endpoints: BitwardenEndpoints,
  accessToken: string,
  cipherId: string,
): Promise<unknown> {
  if (!/^[0-9a-fA-F-]{36}$/.test(cipherId)) {
    throw new BitwardenApiError("That Bitwarden item id is not a valid identifier", 0);
  }
  return bitwardenGet(endpoints, accessToken, `/ciphers/${cipherId}/details`);
}

/** A stable device identifier keeps Bitwarden from treating every sync as a new device. */
export function newBitwardenDeviceIdentifier(): string {
  return crypto.randomUUID();
}
