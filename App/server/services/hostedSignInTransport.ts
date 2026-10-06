import { z } from "zod";
import { normalizeSignInUrl } from "./runtimeSettings.js";

const UNAVAILABLE = "Hosted sign-in is unavailable. Please try again later.";
/**
 * Where Gmail Connections issued by releases before Genosyn Connect's
 * provider-neutral routes renew. Nothing new is started there.
 */
const LEGACY_GOOGLE_PATH = "/api/google-sign-in";
const DISCOVERY_TTL_MS = 30_000;
const providerSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
/**
 * Protocol 2: the service keeps no state and returns the credential through
 * the browser, encrypted to this installation. A service that answers with
 * any other version cannot finish a sign-in this installation starts, so it
 * counts as not offering one.
 */
const statusSchema = z.object({
  version: z.literal(2),
  available: z.boolean(),
  scopes: z.array(z.string().min(1).max(256)).max(256),
});

/** What a sign-in service offers for one provider, as its status route reports it. */
export type HostedSignInOffer = {
  path: string;
  /** Every scope the service will request for an installation. */
  scopes: string[];
};

const discovery = new Map<
  string,
  { expiresAt: number; result: Promise<HostedSignInOffer | null> }
>();

class SignInTransportError extends Error {
  constructor(readonly status?: number) {
    super(UNAVAILABLE);
  }
}

/** Stored paths are protocol identifiers, never arbitrary token destinations. */
export function validateHostedSignInPath(provider: string, path: string): string {
  if (
    !providerSchema.safeParse(provider).success ||
    (path !== `/api/connect/${provider}` && !(provider === "google" && path === LEGACY_GOOGLE_PATH))
  ) {
    throw new SignInTransportError();
  }
  return path;
}

/** Only the saved issuer/path receives tokens. Never follow redirects, forward
 * browser cookies, or expose upstream bodies and fetch errors. */
export async function requestHostedSignIn(
  issuer: string,
  provider: string,
  path: string,
  operation: "status" | "start" | "refresh",
  payload?: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  const origin = normalizeSignInUrl(issuer);
  if (!origin) throw new SignInTransportError();
  validateHostedSignInPath(provider, path);
  try {
    const response = await fetch(`${origin}${path}/${operation}`, {
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
      throw new SignInTransportError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SignInTransportError();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new SignInTransportError();
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SignInTransportError) throw error;
    throw new SignInTransportError();
  }
}

async function readOffer(
  origin: string,
  provider: string,
  path: string,
): Promise<HostedSignInOffer | null> {
  const status = statusSchema.safeParse(
    await requestHostedSignIn(origin, provider, path, "status", undefined, 2000),
  );
  if (!status.success || !status.data.available) return null;
  return { path, scopes: status.data.scopes };
}

function cached(key: string, load: () => Promise<HostedSignInOffer | null>) {
  const hit = discovery.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;
  const result = load();
  if (discovery.size >= 64) discovery.clear();
  discovery.set(key, { expiresAt: Date.now() + DISCOVERY_TTL_MS, result });
  return result;
}

/**
 * Discover what a service offers for a provider with a public status call
 * only. Null means "not offered here right now", which includes a service
 * that speaks another protocol version. Throws when the service cannot be
 * reached at all.
 */
export async function discoverHostedSignIn(
  issuer: string,
  provider: string,
): Promise<HostedSignInOffer | null> {
  const path = validateHostedSignInPath(provider, `/api/connect/${provider}`);
  const origin = normalizeSignInUrl(issuer);
  if (!origin) throw new SignInTransportError();
  return cached(`${origin}${path}`, () => readOffer(origin, provider, path));
}

export function resetHostedSignInDiscoveryForTests(): void {
  discovery.clear();
}
