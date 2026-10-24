import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { In, IsNull, LessThan, MoreThan } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { ConnectedApp } from "../../db/entities/ConnectedApp.js";
import { OAuthClient, type OAuthClientAuthMethod } from "../../db/entities/OAuthClient.js";

/**
 * OAuth clients that registered themselves (RFC 7591), and how one proves who
 * it is at the token endpoint.
 *
 * Registration is open — claude.ai and ChatGPT register before anyone has
 * signed in — so a client is only a name and the addresses its codes may be
 * sent to. The rules on those addresses are what keep a code from going
 * anywhere else: an exact, registered `https` URL, or `http` on the person's
 * own machine for a desktop client. Nothing else — no custom schemes, no
 * fragments, no credentials in the URL.
 */

export class OAuthProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthProtocolError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How many redirect URIs one client may register. */
export const MAX_REDIRECT_URIS = 10;

/** Why `uri` may not receive authorization codes, or null when it may. */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > 2000) return "A redirect URI may be at most 2000 characters.";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `"${uri}" is not an absolute URL.`;
  }
  if (url.hash || uri.includes("#")) return "A redirect URI may not have a fragment.";
  if (url.username || url.password) return "A redirect URI may not carry credentials.";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol === "http:") {
    return "A redirect URI must use https, or http only on this computer (localhost, 127.0.0.1 or [::1]).";
  }
  return `Redirect URIs must use https; "${url.protocol}" is not accepted.`;
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether `requested` is one of the client's registered redirect URIs: the
 * same string, or — for an http loopback address, whose port a desktop client
 * picks when it starts listening (RFC 8252 §7.3) — the same URI on any port.
 */
export function redirectUriRegistered(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let candidate: URL;
  try {
    candidate = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(candidate) || redirectUriProblem(requested)) return false;
  return registered.some((entry) => {
    let known: URL;
    try {
      known = new URL(entry);
    } catch {
      return false;
    }
    return (
      isLoopbackHttp(known) &&
      known.hostname === candidate.hostname &&
      known.pathname === candidate.pathname &&
      known.search === candidate.search
    );
  });
}

export function redirectUrisOf(client: OAuthClient): string[] {
  try {
    const parsed: unknown = JSON.parse(client.redirectUrisJson);
    return Array.isArray(parsed)
      ? parsed.filter((uri): uri is string => typeof uri === "string")
      : [];
  } catch {
    return [];
  }
}

/** RFC 7591 client metadata. Fields this server does not use are accepted and ignored. */
export const clientRegistrationSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
    client_name: z.string().max(500).optional(),
    client_uri: z.string().max(2000).optional(),
    token_endpoint_auth_method: z.string().max(100).optional(),
    grant_types: z.array(z.string().max(100)).max(10).optional(),
    response_types: z.array(z.string().max(100)).max(10).optional(),
    scope: z.string().max(1000).optional(),
  })
  .passthrough();

export type ClientRegistration = z.infer<typeof clientRegistrationSchema>;

const AUTH_METHODS: readonly OAuthClientAuthMethod[] = [
  "none",
  "client_secret_post",
  "client_secret_basic",
];
const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

export function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Control and direction characters, which could hide or reorder what is shown beside a name. */
function invisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** A name to show for the client: printable, one line, never empty. */
export function displayName(name: string | undefined): string {
  const cleaned = Array.from(name ?? "", (char) =>
    invisible(char.codePointAt(0) ?? 0) ? " " : char,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "Unnamed app";
}

/** How many registrations from one address an hour (the MCP SDK's own server allows 20). */
export const REGISTRATION_RATE_LIMIT = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 15 };

/**
 * How many registrations from the last day may be waiting, never used, at
 * once. The per-address limit cannot stop many addresses; this bounds what
 * they can leave behind until the unused ones are pruned.
 */
export const MAX_UNUSED_RECENT_REGISTRATIONS = 2000;

/** Register a client, answering with the RFC 7591 client information response. */
export async function registerClient(metadata: ClientRegistration, now = new Date()) {
  for (const uri of metadata.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthProtocolError("invalid_redirect_uri", problem);
  }
  const method = (metadata.token_endpoint_auth_method ?? "none") as OAuthClientAuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.`,
    );
  }
  const grantTypes = metadata.grant_types ?? ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code") || grantTypes.some((g) => !GRANT_TYPES.has(g))) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      "grant_types may be authorization_code and refresh_token, and must include authorization_code.",
    );
  }
  const responseTypes = metadata.response_types ?? ["code"];
  if (responseTypes.some((type) => type !== "code")) {
    throw new OAuthProtocolError("invalid_client_metadata", 'response_types may only be "code".');
  }
  let clientUri: string | null = null;
  if (metadata.client_uri) {
    try {
      const parsed = new URL(metadata.client_uri);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") clientUri = parsed.href;
    } catch {
      clientUri = null;
    }
  }

  const waiting = await AppDataSource.getRepository(OAuthClient).countBy({
    lastUsedAt: IsNull(),
    createdAt: MoreThan(new Date(now.getTime() - 86_400_000)),
  });
  if (waiting >= MAX_UNUSED_RECENT_REGISTRATIONS) {
    throw new OAuthProtocolError(
      "temporarily_unavailable",
      "Too many apps have registered without being used. Try again later.",
      503,
    );
  }

  const clientId = `gci_${randomBytes(16).toString("base64url")}`;
  const secret = method === "none" ? null : `gcs_${randomBytes(32).toString("base64url")}`;
  const redirectUris = [...new Set(metadata.redirect_uris)];
  const repo = AppDataSource.getRepository(OAuthClient);
  const client = await repo.save(
    repo.create({
      clientId,
      clientSecretHash: secret ? hashClientSecret(secret) : null,
      tokenEndpointAuthMethod: method,
      name: displayName(metadata.client_name),
      clientUri,
      redirectUrisJson: JSON.stringify(redirectUris),
      lastUsedAt: null,
    }),
  );
  return {
    client_id: client.clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirectUris,
    grant_types: [...new Set(grantTypes)],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
}

export async function findClient(clientId: string | undefined | null): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 64) return null;
  return AppDataSource.getRepository(OAuthClient).findOneBy({ clientId });
}

export function touchClient(client: OAuthClient): void {
  void AppDataSource.getRepository(OAuthClient)
    .update({ id: client.id }, { lastUsedAt: new Date() })
    .catch(() => undefined);
}

function secretMatches(client: OAuthClient, secret: string): boolean {
  if (!client.clientSecretHash) return false;
  const given = Buffer.from(hashClientSecret(secret), "hex");
  const stored = Buffer.from(client.clientSecretHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** The client credentials a token or revocation request carries (RFC 6749 §2.3.1). */
export type PresentedClient = {
  clientId: string | null;
  secret: string | null;
  /** The credentials came in `Authorization: Basic`, so a failure answers with that challenge. */
  basic: boolean;
};

export function presentedClient(
  authorization: string | undefined,
  body: Record<string, unknown>,
): PresentedClient {
  const bodyId = typeof body.client_id === "string" ? body.client_id : null;
  const bodySecret = typeof body.client_secret === "string" ? body.client_secret : null;
  const header = authorization?.trim() ?? "";
  if (/^basic\s+/i.test(header)) {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, ""), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) {
      const decode = (value: string) => {
        try {
          return decodeURIComponent(value.replace(/\+/g, " "));
        } catch {
          return value;
        }
      };
      return {
        clientId: decode(decoded.slice(0, colon)),
        secret: decode(decoded.slice(colon + 1)),
        basic: true,
      };
    }
    return { clientId: null, secret: null, basic: true };
  }
  return { clientId: bodyId, secret: bodySecret, basic: false };
}

/**
 * The client a request authenticates as. A public client names itself; a
 * confidential one must also present the secret it was issued, in either
 * place RFC 6749 allows.
 */
export async function authenticateClient(presented: PresentedClient): Promise<OAuthClient> {
  const client = await findClient(presented.clientId);
  const refuse = () =>
    new OAuthProtocolError("invalid_client", "The client is unknown or its secret is wrong.", 401);
  if (!client) throw refuse();
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!presented.secret || !secretMatches(client, presented.secret)) throw refuse();
  }
  return client;
}

/** Clients nobody has connected, unused for this long, are deleted. */
export const UNUSED_CLIENT_RETENTION_DAYS = 30;

/**
 * Delete registrations that never became a connected app and have not been
 * used for a month. Registration is open, so this is what keeps it bounded.
 */
export async function pruneUnusedClients(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNUSED_CLIENT_RETENTION_DAYS * 86_400_000);
  const repo = AppDataSource.getRepository(OAuthClient);
  const stale = await repo.find({
    select: { id: true },
    where: [
      { lastUsedAt: IsNull(), createdAt: LessThan(cutoff) },
      { lastUsedAt: LessThan(cutoff) },
    ],
    take: 500,
  });
  if (!stale.length) return 0;
  const ids = stale.map((row) => row.id);
  const connected = await AppDataSource.getRepository(ConnectedApp).find({
    select: { oauthClientId: true },
    where: { oauthClientId: In(ids) },
  });
  const keep = new Set(connected.map((row) => row.oauthClientId));
  const remove = ids.filter((id) => !keep.has(id));
  if (!remove.length) return 0;
  const result = await repo.delete({ id: In(remove) });
  return result.affected ?? 0;
}
