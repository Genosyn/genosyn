import { z } from "zod";
import { UpstreamError } from "../errors.js";
import { upstreamJson, type Fetch } from "../upstream.js";
import type { ConnectProvider, ProviderRegistration, ScopeGroup } from "./types.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
] as const;

/**
 * Every Google product a Genosyn installation knows how to use. The keys are
 * what an operator lists in CONNECT_GOOGLE_SCOPE_GROUPS; the scopes match the
 * App's Integration catalog exactly, because the App asks for scopes, not keys.
 *
 * Offering a group is a promise the operator's Google app is verified for its
 * scopes. Gmail, Drive and several others are restricted scopes that need
 * Google's security assessment before strangers can consent to them.
 */
export const GOOGLE_SCOPE_GROUPS: readonly ScopeGroup[] = [
  {
    key: "gmail",
    label: "Gmail",
    description: "Read, send, draft, label and archive email, and manage basic mail settings.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ],
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "See, create, change and delete events on your calendars.",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  },
  {
    key: "drive",
    label: "Drive",
    description: "See, create, edit and delete files in your Google Drive.",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
  {
    key: "docs",
    label: "Docs, Sheets and Slides",
    description: "See, create and edit your documents, spreadsheets and presentations.",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    description: "See and manage your tasks.",
    scopes: ["https://www.googleapis.com/auth/tasks"],
  },
  {
    key: "contacts",
    label: "Contacts",
    description: "See and edit your contacts.",
    scopes: ["https://www.googleapis.com/auth/contacts"],
  },
  {
    key: "directory",
    label: "Directory",
    description: "See your organization's user directory.",
    scopes: ["https://www.googleapis.com/auth/directory.readonly"],
  },
  {
    key: "chat",
    label: "Chat",
    description: "Read and send messages in Google Chat.",
    scopes: ["https://www.googleapis.com/auth/chat.messages"],
  },
  {
    key: "meet",
    label: "Meet",
    description: "Create Google Meet meetings.",
    scopes: ["https://www.googleapis.com/auth/meetings.space.created"],
  },
  {
    key: "analytics",
    label: "Google Analytics",
    description: "Read your Analytics accounts, properties and reports.",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  },
  {
    key: "search-console",
    label: "Search Console",
    description: "Read your Search Console properties and search performance.",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  },
  {
    key: "ads",
    label: "Google Ads",
    description: "See and manage your Google Ads accounts and campaigns.",
    scopes: ["https://www.googleapis.com/auth/adwords"],
  },
];

export const DEFAULT_GOOGLE_SCOPE_GROUPS = ["gmail"];

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string().max(8192).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});

const profileSchema = z.object({
  email: z.string().email().max(320),
  email_verified: z.literal(true),
});

export function createGoogleProvider(options: {
  registration: ProviderRegistration | null;
  /** Keys from {@link GOOGLE_SCOPE_GROUPS}; validated by the config loader. */
  groups: readonly string[];
  fetch?: Fetch;
}): ConnectProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const offered = new Set(options.groups);

  async function tokenRequest(body: URLSearchParams) {
    const result = await upstreamJson(fetchImpl, TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!result.ok) {
      const error =
        result.body && typeof result.body === "object" && "error" in result.body
          ? (result.body as { error: unknown }).error
          : undefined;
      if (error === "invalid_grant") {
        throw new UpstreamError(
          "Google access expired or was revoked. Connect again.",
          401,
          "exchange_failed",
        );
      }
      throw new UpstreamError("Google sign-in could not be completed. Please try again.");
    }
    const parsed = tokenSchema.safeParse(result.body);
    if (!parsed.success) throw new UpstreamError();
    return {
      accessToken: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
    };
  }

  return {
    id: "google",
    name: "Google",
    authorizationOrigin: "https://accounts.google.com",
    continueLabel: "Continue with Google",
    registration: options.registration,
    identityScopes: GOOGLE_IDENTITY_SCOPES,
    catalog: GOOGLE_SCOPE_GROUPS,
    groups: GOOGLE_SCOPE_GROUPS.filter((group) => offered.has(group.key)),
    authorizeUrl(args) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: args.clientId,
        redirect_uri: args.redirectUri,
        response_type: "code",
        scope: args.scopes.join(" "),
        // A refresh token is the whole point: without offline access and a
        // forced consent screen Google returns one only on the first grant.
        access_type: "offline",
        prompt: "consent",
        // Each Connection holds exactly what it asked for, never grants that
        // another installation once received for the same account.
        include_granted_scopes: "false",
        code_challenge: args.codeChallenge,
        code_challenge_method: "S256",
        state: args.state,
      }).toString();
      return url.toString();
    },
    async exchange(args) {
      const tokens = await tokenRequest(
        new URLSearchParams({
          client_id: args.clientId,
          client_secret: args.clientSecret,
          code: args.code,
          code_verifier: args.codeVerifier,
          redirect_uri: args.redirectUri,
          grant_type: "authorization_code",
        }),
      );
      if (!tokens.refreshToken) {
        throw new UpstreamError(
          "Google did not grant offline access. Connect again and allow access.",
          400,
          "offline_access_missing",
        );
      }
      const profile = await upstreamJson(fetchImpl, USERINFO_URL, {
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
      });
      const parsed = profile.ok ? profileSchema.safeParse(profile.body) : null;
      if (!parsed?.success) {
        throw new UpstreamError(
          "Google did not confirm a verified email address for this account. Try another account.",
          400,
          "account_unverified",
        );
      }
      return {
        clientId: args.clientId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope ?? "",
        email: parsed.data.email,
        account: parsed.data.email,
      };
    },
    async refresh(args) {
      return tokenRequest(
        new URLSearchParams({
          client_id: args.clientId,
          client_secret: args.clientSecret,
          refresh_token: args.refreshToken,
          grant_type: "refresh_token",
        }),
      );
    },
  };
}
