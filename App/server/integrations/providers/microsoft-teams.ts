import crypto from "node:crypto";

import { ConnectionAuthError } from "../types.js";
import type { IntegrationConfig, IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Microsoft Teams — the same shape as Telegram (a bot humans talk to, plus a
 * small outbound tool surface), running on the Azure Bot Service instead of a
 * first-party API.
 *
 * The inbound half lives in `services/chatSurfaces/microsoftTeams.ts`:
 * Microsoft Teams is webhook-only, so Microsoft POSTs activities at the
 * instance's public URL and the adapter authenticates each one. Nothing in
 * this file is reachable without that route having run first, which is the
 * one genuinely surprising thing about this integration and the reason the
 * tool descriptions below say so out loud.
 *
 * Auth is a client-credentials triple on the Azure Bot's Entra app
 * registration — Application (client) ID, a client secret, and (for a bot
 * registered single-tenant) the tenant id. There is no OAuth handshake and no
 * user consent: the bot authenticates as itself, mints a Bot Framework token,
 * and presents it as a bearer on every outbound call. Microsoft Advertising
 * (`microsoft-ads.ts`) talks to the same identity platform for a user-delegated
 * token; the mechanics rhyme, the grant does not, so the two do not share code.
 *
 * The **audience is not the tenant**. A multi-tenant bot authenticates against
 * the `botframework.com` authority rather than its own tenant, which is why
 * `tenantId` is optional here and why filling it in for a multi-tenant bot is
 * the classic way to get `AADSTS700016` on an otherwise perfect secret.
 */

/**
 * The authority a multi-tenant Azure Bot authenticates against. Not a
 * placeholder and not a typo — `botframework.com` is a real tenant Microsoft
 * operates for exactly this purpose.
 */
const MULTI_TENANT_AUTHORITY = "botframework.com";

/** The only scope a bot ever asks for. */
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";

/**
 * Bot Framework tokens last about 24 hours. We refresh a minute early so a
 * request that starts just under the wire still has a live token by the time
 * Microsoft reads it.
 */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Fallback lifetime when the token response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export type MicrosoftTeamsConfig = {
  /** Application (client) ID of the Azure Bot's Entra app. Also the JWT audience. */
  appId: string;
  /** Client secret. Never leaves this module or the encrypted config. */
  appPassword: string;
  /** Set only for a bot registered single-tenant. */
  tenantId?: string;
};

// ---------- Token cache ----------

type CachedToken = { token: string; expiresAt: number };

const TOKEN_CACHE = new Map<string, CachedToken>();

/**
 * Cache per credential triple, not per Connection.
 *
 * Two Connections pointing at one Azure Bot are the same identity to
 * Microsoft, and keying on the connection id would mint two tokens for it.
 * The key hashes the secret rather than holding it: rotating the client
 * secret has to invalidate the cache, and a plaintext secret sitting in a
 * long-lived Map key is a needless second copy of it.
 */
export function botFrameworkCacheKey(config: MicrosoftTeamsConfig): string {
  return crypto
    .createHash("sha256")
    .update(`${config.tenantId ?? ""}\u0000${config.appId}\u0000${config.appPassword}`)
    .digest("hex");
}

export function readCachedBotFrameworkToken(key: string, now = Date.now()): string | null {
  const hit = TOKEN_CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAt - TOKEN_REFRESH_SKEW_MS <= now) {
    TOKEN_CACHE.delete(key);
    return null;
  }
  return hit.token;
}

export function cacheBotFrameworkToken(
  key: string,
  token: string,
  expiresInSeconds: number,
  now = Date.now(),
): void {
  const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? expiresInSeconds
    : DEFAULT_TOKEN_TTL_SECONDS;
  TOKEN_CACHE.set(key, { token, expiresAt: now + ttl * 1000 });
}

/** Drop every cached token. Tests and a credential edit both want this. */
export function clearBotFrameworkTokenCache(): void {
  TOKEN_CACHE.clear();
}

/** Which Entra authority mints this bot's token. */
export function botFrameworkTokenUrl(config: MicrosoftTeamsConfig): string {
  const tenant = (config.tenantId ?? "").trim() || MULTI_TENANT_AUTHORITY;
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

/**
 * Mint (or reuse) a Bot Framework token for one credential triple.
 *
 * `forceRefresh` exists for the two callers whose whole job is to prove the
 * credentials still work — validate-on-save and the Check button. A cached
 * answer would let both report Connected on a secret Microsoft revoked
 * yesterday.
 */
export async function botFrameworkToken(
  config: MicrosoftTeamsConfig,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  const appId = (config.appId ?? "").trim();
  const appPassword = (config.appPassword ?? "").trim();
  if (!appId) throw new Error("Application (client) ID is required");
  if (!appPassword) throw new Error("Client secret is required");

  const key = botFrameworkCacheKey({ ...config, appId, appPassword });
  if (!opts.forceRefresh) {
    const cached = readCachedBotFrameworkToken(key);
    if (cached) return cached;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: appId,
    client_secret: appPassword,
    scope: BOT_FRAMEWORK_SCOPE,
  });
  const res = await fetch(botFrameworkTokenUrl({ ...config, appId, appPassword }), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const parsed = (await safeJson(res)) as Record<string, unknown> | null;
  if (!res.ok || !parsed || typeof parsed !== "object") {
    const message = microsoftErrorMessage(
      parsed,
      `Microsoft Teams token request failed: ${res.status}`,
    );
    // `invalid_client` / `unauthorized_client` mean the triple itself is
    // wrong or the secret expired — the Connection is unusable until a human
    // pastes a new one, so mark the row rather than reporting a transient blip.
    const code = parsed && typeof parsed === "object" ? String(parsed.error ?? "") : "";
    if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
      throw new ConnectionAuthError(
        `${message} Check the Application (client) ID, the client secret, and — for a single-tenant bot only — the tenant id.`,
        "expired",
      );
    }
    throw new Error(message);
  }
  const token = parsed.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("Microsoft returned no access_token for the Bot Framework scope.");
  }
  const expiresIn =
    typeof parsed.expires_in === "number" ? parsed.expires_in : DEFAULT_TOKEN_TTL_SECONDS;
  cacheBotFrameworkToken(key, token, expiresIn);
  return token;
}

// ---------- Service URL ----------

/**
 * A `serviceUrl` with a single trailing slash.
 *
 * Microsoft sends it both ways — `https://smba.trafficmanager.net/emea/` in
 * one activity and the same host without the slash in the next — and every
 * Bot Framework path is appended to it. Normalizing once here is the
 * difference between a reply and a 404 that only reproduces in one region.
 */
export function normalizeServiceUrl(serviceUrl: string): string {
  const trimmed = (serviceUrl ?? "").trim();
  if (!trimmed) return "";
  return `${trimmed.replace(/\/+$/, "")}/`;
}

/** True for a `serviceUrl` we are willing to send a bearer token to. */
export function isUsableServiceUrl(serviceUrl: string): boolean {
  const normalized = normalizeServiceUrl(serviceUrl);
  if (!normalized) return false;
  try {
    // https only: the token is a bearer credential, so a plaintext hop would
    // hand it to anyone on the path.
    return new URL(normalized).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------- Transport ----------

/**
 * One authenticated Bot Framework call against a learned `serviceUrl`.
 *
 * `path` is relative and must not start with a slash — the region lives in
 * the `serviceUrl`, and a leading slash would silently throw it away.
 */
export async function botFrameworkFetch<T>(args: {
  config: MicrosoftTeamsConfig;
  serviceUrl: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  if (!isUsableServiceUrl(args.serviceUrl)) {
    throw new Error(`Microsoft Teams: "${args.serviceUrl}" is not a usable https serviceUrl.`);
  }
  const url = `${normalizeServiceUrl(args.serviceUrl)}${args.path.replace(/^\/+/, "")}`;
  const token = await botFrameworkToken(args.config);
  const res = await fetch(url, {
    method: args.method ?? (args.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(args.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(args.body ? { body: JSON.stringify(args.body) } : {}),
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    const message = botFrameworkErrorMessage(
      parsed,
      `Microsoft Teams API ${res.status} ${res.statusText}`,
    );
    if (res.status === 401 || res.status === 403) {
      throw new ConnectionAuthError(message, "expired");
    }
    throw new Error(message);
  }
  return (parsed ?? {}) as T;
}

// ---------- Provider ----------

/** Every tool here can only reach a conversation the bot already heard from. */
const REACHABILITY_NOTE =
  "The bot can only reach a conversation it has already received a message from: the Bot Framework " +
  "serviceUrl (the regional endpoint every outbound call goes to) is learned from inbound traffic, " +
  "never configured. Ask the person to message the AI Employee in Microsoft Teams first.";

export const microsoftTeamsProvider: IntegrationProvider = {
  catalog: {
    provider: "microsoft-teams",
    name: "Microsoft Teams",
    category: "Communication",
    tagline: "Talk to an AI Employee from Microsoft Teams.",
    description:
      "Register an Azure Bot (Bot Framework) and point its messaging endpoint at this Genosyn instance, " +
      "then grant the connection to an AI Employee — they answer direct messages, and answer in a channel " +
      "when someone @-mentions the bot. Paste the bot's Application (client) ID and client secret from its " +
      "Entra app registration; add the tenant id only if you registered the bot single-tenant. " +
      "Microsoft Teams is webhook-only, so this needs a publicly reachable HTTPS URL. The same connection " +
      "exposes outbound tools so a granted AI Employee can post back into a conversation it already knows.",
    icon: "MessagesSquare",
    authMode: "apikey",
    fields: [
      {
        key: "appId",
        label: "Application (client) ID",
        type: "text",
        placeholder: "00000000-0000-0000-0000-000000000000",
        required: true,
        hint: "Application (client) ID of the Azure Bot's Entra app.",
      },
      {
        key: "appPassword",
        label: "Client secret",
        type: "password",
        placeholder: "the secret value, not its id",
        required: true,
        hint: "Entra app registration → Certificates & secrets. Copy the Value column; the Secret ID will not work.",
      },
      {
        key: "tenantId",
        label: "Tenant ID",
        type: "text",
        placeholder: "leave blank for a multi-tenant bot",
        required: false,
        hint: "Only for a single-tenant bot. A multi-tenant bot authenticates against botframework.com, and filling this in will break it.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "send_message",
      description: `Post a message into a Microsoft Teams conversation — a direct chat, a group chat, or a channel thread. ${REACHABILITY_NOTE} \`conversationId\` is the id from an inbound message.`,
      inputSchema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description:
              "Bot Framework conversation id from an inbound message, e.g. `19:…@thread.tacv2`.",
          },
          text: {
            type: "string",
            description: "Message body. Markdown is rendered by Microsoft Teams.",
          },
        },
        required: ["conversationId", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "list_conversation_members",
      description: `List the people in a Microsoft Teams conversation — display name, Entra object id, and email where Microsoft exposes one. ${REACHABILITY_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "Bot Framework conversation id from an inbound message.",
          },
        },
        required: ["conversationId"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const appId = (input.appId ?? "").trim();
    const appPassword = (input.appPassword ?? "").trim();
    const tenantId = (input.tenantId ?? "").trim();
    if (!appId) throw new Error("Application (client) ID is required");
    if (!appPassword) throw new Error("Client secret is required");

    const config: MicrosoftTeamsConfig = {
      appId,
      appPassword,
      ...(tenantId ? { tenantId } : {}),
    };
    // A 200 from the token endpoint proves all three at once — there is no
    // cheaper call, and no call at all that works before Microsoft Teams has
    // sent us a serviceUrl.
    await botFrameworkToken(config, { forceRefresh: true });

    return {
      config: config as unknown as IntegrationConfig,
      accountHint: tenantId
        ? `Microsoft Teams app ${maskSecret(appId)} · single-tenant`
        : `Microsoft Teams app ${maskSecret(appId)}`,
    };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as unknown as MicrosoftTeamsConfig;
    try {
      await botFrameworkToken(cfg, { forceRefresh: true });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        status: err instanceof ConnectionAuthError ? err.connectionStatus : "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as unknown as MicrosoftTeamsConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "send_message": {
        const conversationId = requireString(a.conversationId, "conversationId");
        const text = requireString(a.text, "text");
        const sent = await botFrameworkFetch<{ id?: string }>({
          config: cfg,
          serviceUrl: await resolveServiceUrl(ctx.connectionId),
          path: `v3/conversations/${encodeURIComponent(conversationId)}/activities`,
          method: "POST",
          body: { type: "message", text, textFormat: "markdown" },
        });
        return { conversationId, activityId: sent.id ?? null };
      }

      case "list_conversation_members": {
        const conversationId = requireString(a.conversationId, "conversationId");
        const members = await botFrameworkFetch<unknown>({
          config: cfg,
          serviceUrl: await resolveServiceUrl(ctx.connectionId),
          path: `v3/conversations/${encodeURIComponent(conversationId)}/members`,
          method: "GET",
        });
        return { conversationId, members: summarizeMembers(members) };
      }

      default:
        throw new Error(`Unknown Microsoft Teams tool: ${name}`);
    }
  },
};

/**
 * Where a tool call gets its `serviceUrl`.
 *
 * The adapter learns it from verified inbound activities and holds it; this
 * module is what the adapter imports to talk to Microsoft. Reaching back the
 * other way with a static import would make the pair a cycle, so the lookup
 * is deferred to call time — which it can afford to be, because a tool call
 * only ever happens long after both modules are loaded.
 */
async function resolveServiceUrl(connectionId: string | undefined): Promise<string> {
  if (!connectionId) {
    throw new Error("Microsoft Teams tools need a Connection; none was supplied.");
  }
  const { lastServiceUrl } = await import("../../services/chatSurfaces/microsoftTeams.js");
  const serviceUrl = lastServiceUrl(connectionId);
  if (!serviceUrl) {
    throw new Error(
      `Microsoft Teams has not contacted this Genosyn instance yet, so there is no endpoint to reply through. ${REACHABILITY_NOTE}`,
    );
  }
  return serviceUrl;
}

/** Flatten the Bot Framework member list into the three fields worth reading. */
export function summarizeMembers(payload: unknown): Array<{
  id: string;
  name: string | null;
  aadObjectId: string | null;
  email: string | null;
}> {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      name: typeof row.name === "string" ? row.name : null,
      aadObjectId: typeof row.aadObjectId === "string" ? row.aadObjectId : null,
      email: typeof row.email === "string" ? row.email : null,
    }))
    .filter((row) => row.id !== "");
}

// ---------- Small helpers ----------

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Microsoft identity platform errors: `{ error, error_description }`. */
export function microsoftErrorMessage(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const o = parsed as Record<string, unknown>;
  if (typeof o.error_description === "string" && o.error_description) {
    // The description is multi-line and ends with a correlation id block that
    // is noise in a connection card.
    return o.error_description.split("\n")[0].trim();
  }
  if (typeof o.error === "string" && o.error) return o.error;
  return fallback;
}

/** Bot Framework errors: `{ error: { code, message } }`. */
export function botFrameworkErrorMessage(parsed: unknown, fallback: string): string {
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (!parsed || typeof parsed !== "object") return fallback;
  const err = (parsed as { error?: unknown }).error;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.code === "string" && o.code) return o.code;
  }
  if (typeof err === "string" && err) return err;
  return fallback;
}
