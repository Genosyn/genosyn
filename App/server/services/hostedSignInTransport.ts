import { z } from "zod";
import { normalizeSignInUrl } from "./runtimeSettings.js";

const UNAVAILABLE = "Hosted sign-in is unavailable. Please try again later.";
const discovery = new Map<string, { expiresAt: number; result: Promise<string | null> }>();
const providerSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const statusSchema = z.object({ version: z.literal(1), available: z.boolean() });

class SignInTransportError extends Error {
  constructor(readonly status?: number) {
    super(UNAVAILABLE);
  }
}

/** Stored paths are protocol identifiers, never arbitrary token destinations. */
export function validateHostedSignInPath(provider: string, path: string): string {
  if (
    !providerSchema.safeParse(provider).success ||
    (path !== `/api/connect/${provider}` &&
      !(provider === "google" && path === "/api/google-sign-in"))
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
  operation: "status" | "start" | "poll" | "refresh",
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

/** Discover with public status calls only; token exchanges never fall back. */
export async function discoverHostedSignInPath(
  issuer: string,
  provider: string,
): Promise<string | null> {
  const path = validateHostedSignInPath(provider, `/api/connect/${provider}`);
  const origin = normalizeSignInUrl(issuer);
  if (!origin) throw new SignInTransportError();
  const key = `${origin}${path}`;
  const cached = discovery.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = (async () => {
    let selectedPath = path;
    let raw: unknown;
    try {
      raw = await requestHostedSignIn(origin, provider, path, "status", undefined, 2000);
    } catch (error) {
      // Older Google hosts only know this route. A disabled provider, outage,
      // redirect, or incompatible protocol must not trigger a downgrade.
      if (!(error instanceof SignInTransportError) || error.status !== 404 || provider !== "google")
        throw error;
      selectedPath = "/api/google-sign-in";
      raw = await requestHostedSignIn(origin, provider, selectedPath, "status", undefined, 2000);
    }
    const status = statusSchema.safeParse(raw);
    return status.success && status.data.available ? selectedPath : null;
  })();
  if (discovery.size >= 64) discovery.clear();
  discovery.set(key, { expiresAt: Date.now() + 30_000, result });
  return result;
}

export function resetHostedSignInDiscoveryForTests(): void {
  discovery.clear();
}
