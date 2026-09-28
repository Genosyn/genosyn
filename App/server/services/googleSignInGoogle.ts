import { z } from "zod";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class GoogleSignInUpstreamError extends Error {
  constructor(
    message = "Google sign-in could not be completed. Please try again.",
    public readonly status = 502,
  ) {
    super(message);
    this.name = "GoogleSignInUpstreamError";
  }
}

/** Fixed Google endpoints only. Neither response bodies nor fetch errors leave here. */
async function googleJson(url: typeof TOKEN_URL | typeof USERINFO_URL, init: RequestInit) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new GoogleSignInUpstreamError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GoogleSignInUpstreamError();
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!response.ok) {
      if (body && typeof body === "object" && "error" in body && body.error === "invalid_grant") {
        throw new GoogleSignInUpstreamError(
          "Gmail access expired or was revoked. Connect Gmail again.",
          401,
        );
      }
      throw new GoogleSignInUpstreamError();
    }
    return body;
  } catch (error) {
    if (error instanceof GoogleSignInUpstreamError) throw error;
    throw new GoogleSignInUpstreamError();
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string().max(8192).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});

async function requestTokens(body: URLSearchParams) {
  const result = tokenSchema.safeParse(
    await googleJson(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
  if (!result.success) throw new GoogleSignInUpstreamError();
  return {
    accessToken: result.data.access_token,
    expiresAt: Date.now() + result.data.expires_in * 1000,
    ...(result.data.refresh_token ? { refreshToken: result.data.refresh_token } : {}),
    ...(result.data.scope ? { scope: result.data.scope } : {}),
  };
}

export async function exchangeHostedGoogleCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const tokens = await requestTokens(
    new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }),
  );
  const profile = z
    .object({
      email: z.string().email().max(320),
      email_verified: z.literal(true),
    })
    .safeParse(
      await googleJson(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }),
    );
  if (!profile.success) throw new GoogleSignInUpstreamError();
  return { ...tokens, email: profile.data.email };
}

export async function refreshHostedGoogleToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  return requestTokens(
    new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: "refresh_token",
    }),
  );
}
