import type {
  IntegrationConfig,
  IntegrationProvider,
  IntegrationScopeGroup,
} from "../types.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
  GOOGLE_OAUTH_IDENTITY_SCOPES,
  mintServiceAccountToken,
  parseServiceAccountKey,
  resolveScopeGroups,
  type GoogleOauthConfig,
  type GoogleServiceAccountConfig,
} from "./google/auth.js";
import { gmailTools, invokeGmailTool } from "./google/gmail-tools.js";
import { driveTools, invokeDriveTool } from "./google/drive-tools.js";

/**
 * Google Workspace — umbrella OAuth + Service Account integration.
 *
 * One `IntegrationConnection` row covers a single Google account (or a
 * single service account) and exposes tools from multiple Google
 * products. The scope set is **user-pickable** at connect/reconnect
 * time: the catalog lists scope groups (`GOOGLE_SCOPE_GROUPS`) like
 * "Mail" or "Calendar", the UI renders them as checkboxes, and the
 * server resolves the chosen keys to the underlying URL scopes. Tools
 * currently ship for Gmail and Drive; the rest are pre-wired so users
 * can grant them now and use them once tool families land.
 *
 * The OAuth + Service-Account credential shapes and token lifecycle are
 * shared with the standalone Google providers (Analytics, Search Console)
 * via `google/auth.ts`; this file only carries Workspace's scope catalog
 * and tool dispatch.
 *
 * Two auth modes are supported, picked at create-time:
 *
 *   • OAuth (`authMode="oauth2"`): each Connection brings its own
 *     `clientId` + `clientSecret` (registered with Google Cloud) and runs
 *     the standard 3-legged consent dance. Works for any Google account,
 *     including personal `@gmail.com` — though Workspace-only scope groups
 *     (Chat, Meet, Directory) simply won't be granted for personal
 *     accounts; we read the actual granted scope off the token response.
 *
 *   • Service account (`authMode="service_account"`): each Connection
 *     uploads a Google Cloud service-account JSON key. With an optional
 *     `impersonationEmail`, the SA acts on a Workspace user's behalf via
 *     domain-wide delegation. Does not work with personal `@gmail.com`.
 *
 * OAuth additionally requests `userinfo.email` + `openid` so we know
 * which account just authorised — those are the OAuth baseline and can't
 * be unchecked.
 */

/**
 * User-pickable scope bundles. The connect/reconnect UI renders these as
 * checkboxes; the OAuth start endpoint resolves the keys back to the URL
 * scope list. Adding a new product (say, YouTube) is a single entry here.
 */
export const GOOGLE_SCOPE_GROUPS: IntegrationScopeGroup[] = [
  {
    key: "mail",
    label: "Gmail",
    description: "Read, draft, send, label email; manage filters/forwarding.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ],
  },
  {
    key: "drive",
    label: "Drive",
    description: "Search, read, create, and edit files in Drive.",
    scopes: ["https://www.googleapis.com/auth/drive"],
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Read and manage events on the user's calendars.",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  },
  {
    key: "docs",
    label: "Docs / Sheets / Slides",
    description: "Read and edit Google Docs, Sheets, and Slides.",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ],
  },
  {
    key: "tasks",
    label: "Tasks",
    description: "Read and manage Google Tasks.",
    scopes: ["https://www.googleapis.com/auth/tasks"],
  },
  {
    key: "contacts",
    label: "Contacts",
    description: "Read and edit personal contacts (People API).",
    scopes: ["https://www.googleapis.com/auth/contacts"],
  },
  {
    key: "directory",
    label: "Directory",
    description: "Read your Workspace org's user directory.",
    scopes: ["https://www.googleapis.com/auth/directory.readonly"],
    workspaceOnly: true,
  },
  {
    key: "chat",
    label: "Chat",
    description: "Read and send messages in Google Chat.",
    scopes: ["https://www.googleapis.com/auth/chat.messages"],
    workspaceOnly: true,
  },
  {
    key: "meet",
    label: "Meet",
    description: "Create Meet spaces.",
    scopes: ["https://www.googleapis.com/auth/meetings.space.created"],
    workspaceOnly: true,
  },
];

/** OAuth requires `openid` + `userinfo.email` regardless of which products
 * the user picked — that's how we identify which Google account just
 * authorised. SA tokens skip these (the JWT identifies the SA itself). */
const GOOGLE_OAUTH_BASELINE_SCOPES = GOOGLE_OAUTH_IDENTITY_SCOPES;

const GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES: string[] = [];

/**
 * Resolve a list of scope-group keys → flat scope URL list against the
 * Workspace scope catalog. Thin wrapper over the shared `resolveScopeGroups`.
 */
export function resolveGoogleScopes(args: {
  scopeGroups: string[];
  baseline: string[];
}): string[] {
  return resolveScopeGroups({
    keys: args.scopeGroups,
    groups: GOOGLE_SCOPE_GROUPS,
    baseline: args.baseline,
  });
}

/** All known group keys — the default selection for fresh connections. */
export const ALL_GOOGLE_SCOPE_GROUP_KEYS = GOOGLE_SCOPE_GROUPS.map((g) => g.key);

const ALL_TOOLS = [...gmailTools, ...driveTools];
const GMAIL_TOOL_NAMES = new Set(gmailTools.map((t) => t.name));
const DRIVE_TOOL_NAMES = new Set(driveTools.map((t) => t.name));

export const googleProvider: IntegrationProvider = {
  catalog: {
    provider: "google",
    name: "Google Workspace",
    category: "Productivity",
    tagline: "Connect Gmail, Drive, Calendar, Docs, and more.",
    description:
      "Connect a Google account so AI employees can triage email, search and edit Drive, manage calendars, draft Docs/Sheets/Slides, work with Tasks and Contacts, and post to Chat/Meet. Each Connection brings its own credentials: an OAuth client (recommended for personal Gmail or small teams) or a service account JSON key (Workspace admin / programmatic access).",
    icon: "Mail",
    authMode: "oauth2",
    oauth: {
      app: "google",
      scopes: GOOGLE_OAUTH_BASELINE_SCOPES,
      scopeGroups: GOOGLE_SCOPE_GROUPS,
      setupDocs:
        "https://developers.google.com/identity/protocols/oauth2/web-server",
    },
    serviceAccount: {
      scopes: GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES,
      scopeGroups: GOOGLE_SCOPE_GROUPS,
      // Gmail SAs can't read a mailbox without DWD impersonation, so we
      // surface the field. Drive-only access works without it.
      impersonation: true,
      setupDocs:
        "https://cloud.google.com/iam/docs/service-account-creds#key-types",
    },
    enabled: true,
  },

  tools: ALL_TOOLS,

  buildOauthConfig({ tokens, userInfo, clientId, clientSecret, scopeGroups }) {
    const email = typeof userInfo.email === "string" ? userInfo.email : "";
    if (!tokens.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Make sure the consent screen requested offline access and retry.",
      );
    }
    const cfg: GoogleOauthConfig = {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scope: tokens.scope ?? "",
      email,
      scopeGroups,
    };
    return { config: cfg as unknown as IntegrationConfig, accountHint: email || "Google account" };
  },

  async buildServiceAccountConfig({ keyJson, impersonationEmail, scopeGroups }) {
    const { clientEmail, privateKey, privateKeyId, projectId } =
      parseServiceAccountKey(keyJson);
    const resolvedScopes = resolveGoogleScopes({
      scopeGroups,
      baseline: GOOGLE_SERVICE_ACCOUNT_BASELINE_SCOPES,
    });
    if (resolvedScopes.length === 0) {
      throw new Error(
        "Pick at least one Google service (Mail, Drive, Calendar, …) — service-account tokens need a scope to be useful.",
      );
    }
    const trimmedImpersonation = impersonationEmail?.trim() || undefined;
    const cfg: GoogleServiceAccountConfig = {
      clientEmail,
      privateKey,
      privateKeyId,
      projectId,
      scopes: resolvedScopes,
      scopeGroups,
      impersonationEmail: trimmedImpersonation,
    };
    // Mint once eagerly so the user sees a clear error during connect rather
    // than the first time the AI tries to use it.
    const minted = await mintServiceAccountToken(cfg);
    cfg.accessToken = minted.accessToken;
    cfg.expiresAt = minted.expiresAt;
    const hint = trimmedImpersonation
      ? `${clientEmail} → ${trimmedImpersonation}`
      : clientEmail;
    return { config: cfg as unknown as IntegrationConfig, accountHint: hint };
  },

  async checkStatus(ctx) {
    try {
      await ensureFreshGoogleToken(ctx);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    await ensureFreshGoogleToken(ctx);
    const accessToken = currentGoogleAccessToken(ctx);
    const grantedScope = currentGoogleGrantedScope(ctx);
    if (GMAIL_TOOL_NAMES.has(name)) {
      assertScope(grantedScope, "gmail", name);
      return invokeGmailTool(name, args, accessToken);
    }
    if (DRIVE_TOOL_NAMES.has(name)) {
      assertScope(grantedScope, "drive", name);
      return invokeDriveTool(name, args, accessToken);
    }
    throw new Error(`Unknown Google tool: ${name}`);
  },
};

function assertScope(grantedScope: string, product: "gmail" | "drive", toolName: string): void {
  // `scope` is a space-separated list of full scope URLs. We check the
  // substring "gmail." or "drive." so any granted gmail/drive scope
  // (modify, readonly, …) unlocks the matching tool family.
  const needle = `auth/${product}.`;
  if (!grantedScope.includes(needle)) {
    throw new Error(
      `Tool "${toolName}" requires ${product} access. Reconnect with ${product} scope.`,
    );
  }
}
