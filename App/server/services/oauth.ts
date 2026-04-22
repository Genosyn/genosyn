import crypto from "node:crypto";
import { getProvider } from "../integrations/index.js";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
} from "../integrations/providers/gmail.js";

/**
 * OAuth state store + provider dispatch.
 *
 * Flow for Gmail (and any future Google-backed integration):
 *
 *   1. UI posts `startOauth({ companyId, userId, provider, label })` and
 *      receives `{ authorizeUrl }` to redirect the browser to.
 *   2. Google bounces the browser back to our shared callback:
 *      `${publicUrl}/api/integrations/oauth/callback/google?code=…&state=…`.
 *   3. The callback resolves `state` → the original company/provider/label,
 *      exchanges the code for tokens, asks the provider to shape them into
 *      a config blob, and creates the Connection.
 *
 * State tokens are kept in-process — same philosophy as the short-lived MCP
 * tokens. 10-minute TTL is plenty for a human to click "Allow"; if they
 * take longer we'd rather make them start again than widen the blast radius
 * of a leaked state string.
 */

type OauthState = {
  state: string;
  userId: string;
  companyId: string;
  provider: string;
  label: string;
  expiresAt: number;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, OauthState>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of states) {
    if (v.expiresAt < now) states.delete(k);
  }
}

export function startOauth(args: {
  companyId: string;
  userId: string;
  provider: string;
  label: string;
}): { authorizeUrl: string } {
  sweep();
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (provider.catalog.authMode !== "oauth2") {
    throw new Error(`${provider.catalog.name} is not an OAuth integration`);
  }
  const oauth = provider.catalog.oauth;
  if (!oauth) throw new Error(`${provider.catalog.name} has no OAuth metadata`);

  const state = crypto.randomBytes(24).toString("hex");
  states.set(state, {
    state,
    userId: args.userId,
    companyId: args.companyId,
    provider: args.provider,
    label: args.label,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  let authorizeUrl: string;
  switch (oauth.app) {
    case "google":
      authorizeUrl = buildGoogleAuthorizeUrl(state, oauth.scopes);
      break;
    default:
      throw new Error(`Unsupported OAuth app: ${oauth.app}`);
  }
  return { authorizeUrl };
}

/** Pop a state record — single-use. */
export function resolveOauthState(state: string): OauthState | null {
  sweep();
  const info = states.get(state);
  if (!info) return null;
  states.delete(state);
  if (info.expiresAt < Date.now()) return null;
  return info;
}

/**
 * Dispatch a finished OAuth handshake to the right provider helper. Called
 * from `/api/integrations/oauth/callback/:app`. Returns the provider id
 * (needed because the callback URL is keyed on the OAuth *app*, not the
 * integration itself — Google could back Gmail, Calendar, etc.).
 */
export async function finishOauth(args: {
  app: "google";
  code: string;
  state: OauthState;
}): Promise<{
  provider: string;
  config: Record<string, unknown>;
  accountHint: string;
  companyId: string;
  label: string;
}> {
  switch (args.app) {
    case "google": {
      const provider = getProvider(args.state.provider);
      if (!provider || !provider.buildOauthConfig) {
        throw new Error(`Provider ${args.state.provider} cannot finish OAuth`);
      }
      const { tokens, userInfo } = await exchangeGoogleCode(args.code);
      const { config, accountHint } = provider.buildOauthConfig({
        tokens,
        userInfo,
      });
      return {
        provider: args.state.provider,
        config,
        accountHint,
        companyId: args.state.companyId,
        label: args.state.label,
      };
    }
    default:
      throw new Error(`Unknown OAuth app: ${args.app}`);
  }
}
