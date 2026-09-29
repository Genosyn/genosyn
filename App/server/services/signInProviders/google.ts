import { GOOGLE_SCOPE_GROUPS } from "../../integrations/providers/google.js";
import {
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  hasGoogleGmailMailboxScope,
  resolveScopeGroups,
} from "../../integrations/providers/google/auth.js";
import { getRegisteredOauthApp } from "../oauthApps.js";
import { exchangeHostedGoogleCode, refreshHostedGoogleToken } from "../googleSignInGoogle.js";
import { SignInBrokerError, type SignInProvider } from "../signInBrokerTypes.js";

export type HostedGoogleCredential = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  email: string;
};

/** Only Gmail is hosted; registered Google apps do not grant other products here. */
export const googleSignInProvider: SignInProvider = {
  id: "google",
  throttlePrefix: "gmail-broker",
  authorizationOrigin: "https://accounts.google.com",
  page: {
    title: "Connect Gmail",
    introduction: "Connect Gmail to your Genosyn installation:",
    explanation:
      "It will receive access to read, draft, send, and organize your Gmail. Genosyn handles sign-in and token renewal; your installation connects directly to Google to access your mailbox.",
    continueLabel: "Continue with Google",
  },
  messages: {
    cancelled: "Gmail sign-in was cancelled. Return to your installation to try again.",
    completed: "Gmail sign-in is complete. Return to your installation to finish connecting.",
    failed: "Google sign-in could not be completed. Return to your installation and try again.",
  },
  registration: () => getRegisteredOauthApp("google"),
  authorize(args) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      response_type: "code",
      scope: resolveScopeGroups({
        keys: ["mail"],
        groups: GOOGLE_SCOPE_GROUPS,
        baseline: GOOGLE_OAUTH_IDENTITY_SCOPES,
      }).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      code_challenge: args.codeChallenge,
      code_challenge_method: "S256",
      state: args.state,
    }).toString();
    return url.toString();
  },
  async exchange(args): Promise<HostedGoogleCredential> {
    const tokens = await exchangeHostedGoogleCode(args);
    if (!tokens.refreshToken || !hasGoogleGmailMailboxScope(tokens.scope)) {
      throw new SignInBrokerError(
        "Google did not grant the access Gmail needs. Connect again and allow Gmail access.",
      );
    }
    return {
      clientId: args.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? "",
      email: tokens.email,
    };
  },
  refresh: refreshHostedGoogleToken,
};
