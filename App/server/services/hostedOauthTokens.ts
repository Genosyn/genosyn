import { z } from "zod";
import { requestHostedSignIn } from "./hostedSignInTransport.js";

/** Credentials issued before provider-neutral routes saved no protocol path. */
export const LEGACY_GOOGLE_BROKER_PATH = "/api/google-sign-in";

/**
 * The fields every Connection created through hosted sign-in carries.
 *
 * It holds no client secret: the sign-in service that issued the refresh
 * token owns the secret, so renewal goes back to that exact service and path.
 */
export type HostedOauthCredentials = {
  credentialSource: "hosted";
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  scope: string;
  tokenBrokerUrl: string;
  /** Missing on credentials issued through the original Google broker. */
  tokenBrokerPath?: string;
};

const refreshSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  expiresAt: z.number().finite().positive(),
  refreshToken: z.string().min(1).max(16_384).optional(),
  scope: z.string().max(8192).optional(),
});

/**
 * Renew an access token through the service that issued the Connection.
 *
 * This module has no dependency on the Integration registry on purpose: the
 * Google token lifecycle imports it, and the registry imports Google.
 */
export async function refreshHostedOauthToken<T extends HostedOauthCredentials>(
  provider: string,
  config: T,
): Promise<T> {
  try {
    const refreshed = refreshSchema.parse(
      await requestHostedSignIn(
        config.tokenBrokerUrl,
        provider,
        config.tokenBrokerPath ?? LEGACY_GOOGLE_BROKER_PATH,
        "refresh",
        { clientId: config.clientId, refreshToken: config.refreshToken },
      ),
    );
    if (refreshed.expiresAt <= Date.now()) throw new Error("Expired renewal");
    return { ...config, ...refreshed };
  } catch {
    throw new Error(
      "Genosyn Connect could not renew this Connection's access. Try again later, or reconnect it.",
    );
  }
}
