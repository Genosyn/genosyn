import crypto, { type JsonWebKey, type KeyObject } from "node:crypto";

import {
  botFrameworkFetch,
  isUsableServiceUrl,
  normalizeServiceUrl,
  type MicrosoftTeamsConfig,
} from "../../integrations/providers/microsoft-teams.js";
import type {
  ChatSurfaceAdapter,
  ChatSurfaceWebhookResult,
  InboundChatTurn,
} from "./types.js";

/**
 * The Microsoft Teams chat surface — Azure Bot Service / Bot Framework.
 *
 * Microsoft Teams has no long poll and no socket: Microsoft POSTs each
 * activity to the bot's messaging endpoint, which is why this adapter
 * requires a public URL and starts no worker. That makes the inbound
 * credential a single `Authorization: Bearer <jwt>` header, and makes this
 * file's most important job the one thing an adapter is otherwise never
 * allowed to decide for itself: whether the request really came from
 * Microsoft.
 *
 * The verification below is the real thing — RS256 over `header.payload`
 * against Microsoft's published JWKS, with the issuer, the audience, the
 * validity window and the `serviceUrl` binding all checked. Three details
 * carry most of the weight:
 *
 *  - **The header's `alg` is never trusted.** An implementation that reads
 *    `alg` and picks an algorithm accepts `alg: "none"` and accepts an HS256
 *    token signed with the public key it was about to verify against. This
 *    one requires RS256 and rejects everything else before it looks at a key.
 *  - **The audience must be this Connection's own app id.** Microsoft signs
 *    tokens for every bot in the world with the same keys, so the signature
 *    alone proves nothing about *which* bot the caller is.
 *  - **The `serviceUrl` claim is bound to the activity.** The outbound
 *    endpoint is learned from inbound traffic, so without that check a
 *    forged activity would be a way to point our bearer token at a host of
 *    the attacker's choosing.
 *
 * The other half of an unauthenticated endpoint is what a *rejection* costs
 * us. Anybody can POST a token naming a `kid` Microsoft never issued, and the
 * honest answer to an unknown `kid` — go and see whether the keys rotated —
 * is two outbound requests to login.botframework.com that the caller paid
 * nothing for. So the key loader below refetches at most once per
 * {@link JWKS_REFRESH_COOLDOWN_MS} and shares the one request in flight;
 * inside that window an unknown key is simply a 401, told apart from a bad
 * signature by nobody outside this file.
 *
 * Everything past verification is ordinary translation; the rules about what
 * the employee may then do live in `inbound.ts`, as on every other surface.
 */

/** Bot Framework tokens always carry this issuer. */
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

/** Where Microsoft publishes the signing keys for channel-to-bot tokens. */
export const BOT_FRAMEWORK_OPENID_CONFIG_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/**
 * Microsoft's own guidance for validating these tokens allows five minutes of
 * clock skew, and a self-hosted box with a drifting clock is common enough
 * that a tighter window would fail closed on the operator rather than on an
 * attacker.
 */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Signing keys rotate slowly; a day between refreshes is Microsoft's own advice. */
export const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The shortest gap between two outbound JWKS fetches.
 *
 * A minute buys nothing away from anyone legitimate. Microsoft rotates these
 * keys on the order of days and the honest path is the {@link JWKS_TTL_MS}
 * refresh, so the only thing this window can delay is a rotation, and it
 * delays it by at most one window: the first activity signed by the new key
 * pays for the refetch, and the handful that arrive behind it before it
 * lands are exactly the deliveries Azure retries. What it costs an attacker
 * is the whole attack — a forged `kid` is free to mint, and without a window
 * each one would spend two requests on login.botframework.com and park this
 * process on the network while it waited.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Microsoft Teams rejects a message body over roughly 28 KB. The cap here
 * leaves room for the truncation notice `truncateForSurface` appends and for
 * the markdown-to-HTML expansion Microsoft does on the way in.
 */
export const TEAMS_TEXT_LIMIT = 27_000;

// ---------- Learned service URLs ----------

/**
 * The regional endpoint each Connection's conversations live behind.
 *
 * This is **learned state, not configuration**. The Bot Framework tells a bot
 * where to reply by putting `serviceUrl` on every inbound activity, and there
 * is no API that answers "where does this conversation live" — so a process
 * that has just booted cannot proactively message anybody until Microsoft
 * Teams talks to it again. That is a property of the platform, not a gap
 * worth papering over with a persisted guess: a stale regional endpoint is a
 * 404 at best and someone else's tenant at worst.
 *
 * Only written after a delivery has been verified, which is what stops an
 * unauthenticated caller from re-pointing our outbound bearer token.
 */
const SERVICE_URLS = new Map<string, string>();

export function rememberServiceUrl(connectionId: string, serviceUrl: string): void {
  const normalized = normalizeServiceUrl(serviceUrl);
  if (!connectionId || !isUsableServiceUrl(normalized)) return;
  SERVICE_URLS.set(connectionId, normalized);
}

export function lastServiceUrl(connectionId: string): string | null {
  return SERVICE_URLS.get(connectionId) ?? null;
}

/** Drop every learned endpoint. Tests and a deleted Connection both want this. */
export function forgetServiceUrls(): void {
  SERVICE_URLS.clear();
}

// ---------- JWT verification ----------

export type BotFrameworkKey = JsonWebKey & { kid?: string };

export type BotFrameworkClaims = {
  iss: string;
  aud: string;
  exp: number;
  nbf?: number;
  serviceUrl?: string;
};

/**
 * Every way a delivery can fail to prove itself. Named rather than boolean so
 * the tests can tell "we rejected it" apart from "we rejected it for the
 * reason we meant to" — an HS256 substitution that fails as `bad-signature`
 * would be passing for the wrong reason.
 */
export type BotFrameworkJwtRejection =
  | "malformed"
  | "bad-header"
  | "unsupported-alg"
  | "missing-kid"
  | "unknown-kid"
  | "unsupported-key"
  | "bad-signature"
  | "bad-payload"
  | "bad-issuer"
  | "bad-audience"
  | "expired"
  | "not-yet-valid"
  | "service-url-mismatch";

export type BotFrameworkJwtResult =
  | { ok: true; claims: BotFrameworkClaims }
  | { ok: false; reason: BotFrameworkJwtRejection };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Verify one channel-to-bot token against already-fetched signing keys.
 *
 * Pure by construction — `keys` and `now` are arguments — because the whole
 * security of the surface rests on this function and a check that can only be
 * exercised against Microsoft's live JWKS is a check nobody tests.
 *
 * `serviceUrl` is the activity's own endpoint. Pass it whenever a token is
 * being checked against a delivery (the webhook always does); omit it only
 * when there is no activity to bind to.
 */
export function verifyBotFrameworkJwt(args: {
  token: string;
  appId: string;
  keys: readonly BotFrameworkKey[];
  now?: number;
  serviceUrl?: string;
}): BotFrameworkJwtResult {
  const now = args.now ?? Date.now();
  const token = (args.token ?? "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  if (!BASE64URL.test(headerSeg) || !BASE64URL.test(payloadSeg)) {
    return { ok: false, reason: "malformed" };
  }
  if (signatureSeg && !BASE64URL.test(signatureSeg)) {
    return { ok: false, reason: "malformed" };
  }

  const header = decodeJsonSegment(headerSeg);
  if (!header) return { ok: false, reason: "bad-header" };

  // Read before use, but never *obeyed*: RS256 is the only algorithm the Bot
  // Framework signs with, so anything else — "none", an HS256 token forged
  // with the modulus we were about to verify against, a PSS variant — is
  // refused here rather than dispatched on.
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-alg" };
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return { ok: false, reason: "missing-kid" };

  const jwk = args.keys.find((k) => typeof k.kid === "string" && k.kid === kid);
  if (!jwk) return { ok: false, reason: "unknown-kid" };
  if (jwk.kty !== "RSA") return { ok: false, reason: "unsupported-key" };

  let publicKey: KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return { ok: false, reason: "unsupported-key" };
  }

  if (!signatureSeg) return { ok: false, reason: "bad-signature" };
  let verified = false;
  try {
    verified = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii"),
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(signatureSeg, "base64url"),
    );
  } catch {
    verified = false;
  }
  // Claims are only read once the signature holds, so a tampered payload is
  // reported as a forgery rather than as whatever field the tamper touched.
  if (!verified) return { ok: false, reason: "bad-signature" };

  const payload = decodeJsonSegment(payloadSeg);
  if (!payload) return { ok: false, reason: "bad-payload" };

  if (payload.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: "bad-issuer" };

  const appId = (args.appId ?? "").trim();
  // An unconfigured app id must never match a token's audience; without this
  // a half-filled Connection would accept every bot's traffic.
  if (!appId) return { ok: false, reason: "bad-audience" };
  if (!audienceMatches(payload.aud, appId)) return { ok: false, reason: "bad-audience" };

  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: "expired" };
  if (now > exp * 1000 + CLOCK_SKEW_MS) return { ok: false, reason: "expired" };

  const nbf = payload.nbf;
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) {
      return { ok: false, reason: "not-yet-valid" };
    }
    if (now < nbf * 1000 - CLOCK_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  }

  const claimedServiceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : null;
  if (claimedServiceUrl && args.serviceUrl !== undefined) {
    if (normalizeServiceUrl(claimedServiceUrl) !== normalizeServiceUrl(args.serviceUrl)) {
      return { ok: false, reason: "service-url-mismatch" };
    }
  }

  return {
    ok: true,
    claims: {
      iss: BOT_FRAMEWORK_ISSUER,
      aud: appId,
      exp,
      ...(typeof nbf === "number" ? { nbf } : {}),
      ...(claimedServiceUrl ? { serviceUrl: claimedServiceUrl } : {}),
    },
  };
}

/**
 * Verify, and give Microsoft one chance to have rotated its signing keys.
 *
 * An unknown `kid` is the only rejection worth a second look; every other one
 * is final, and re-fetching a megabyte of JWKS for each forgery would turn a
 * bad token into a denial of service against ourselves. The second look is
 * only ever *asked for* here — whether it costs a request is the key loader's
 * decision, and behind {@link JWKS_REFRESH_COOLDOWN_MS} it usually costs
 * none. That split is the point: this function stays pure enough to drive
 * from a fake `loadKeys`, and everything that talks to the network is rate
 * limited in one place.
 */
export async function verifyBotFrameworkJwtWithKeyRefresh(args: {
  token: string;
  appId: string;
  serviceUrl?: string;
  now?: number;
  loadKeys: (opts: { forceRefresh: boolean }) => Promise<readonly BotFrameworkKey[]>;
}): Promise<BotFrameworkJwtResult> {
  const first = verifyBotFrameworkJwt({
    token: args.token,
    appId: args.appId,
    serviceUrl: args.serviceUrl,
    now: args.now,
    keys: await args.loadKeys({ forceRefresh: false }),
  });
  if (first.ok || first.reason !== "unknown-kid") return first;
  return verifyBotFrameworkJwt({
    token: args.token,
    appId: args.appId,
    serviceUrl: args.serviceUrl,
    now: args.now,
    keys: await args.loadKeys({ forceRefresh: true }),
  });
}

/** Keep only the RSA signing keys we could actually verify with. */
export function parseJwks(payload: unknown): BotFrameworkKey[] {
  const keys = (payload as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  const usable: BotFrameworkKey[] = [];
  for (const entry of keys) {
    if (!entry || typeof entry !== "object") continue;
    const key = entry as Record<string, unknown>;
    if (key.kty !== "RSA") continue;
    if (typeof key.kid !== "string" || !key.kid) continue;
    if (typeof key.n !== "string" || typeof key.e !== "string") continue;
    usable.push(key as BotFrameworkKey);
  }
  return usable;
}

export type BotFrameworkKeyLoader = {
  load: (opts?: { forceRefresh?: boolean }) => Promise<BotFrameworkKey[]>;
  forget: () => void;
  prime: (keys: readonly BotFrameworkKey[]) => void;
};

/**
 * The layer around {@link verifyBotFrameworkJwt} that owns the keys: a cache,
 * one shared in-flight fetch, and the cooldown.
 *
 * A factory rather than three module-level variables because `fetchKeys` and
 * `now` are the two things a test has to hold. A rate limit is only worth
 * something if the number of outbound requests it allows can be counted, and
 * counting them against the real login.botframework.com is not a test.
 */
export function createBotFrameworkKeyLoader(deps: {
  fetchKeys: () => Promise<BotFrameworkKey[]>;
  now?: () => number;
}): BotFrameworkKeyLoader {
  const now = deps.now ?? Date.now;
  let cache: { keys: BotFrameworkKey[]; fetchedAt: number } | null = null;
  let inFlight: Promise<BotFrameworkKey[]> | null = null;
  let lastFetchStartedAt = Number.NEGATIVE_INFINITY;

  async function refresh(
    previous: { keys: BotFrameworkKey[] } | null,
  ): Promise<BotFrameworkKey[]> {
    try {
      const keys = await deps.fetchKeys();
      cache = { keys, fetchedAt: now() };
      return keys;
    } catch (err) {
      // Serving yesterday's keys beats rejecting every activity because
      // login.botframework.com had a bad minute. The keys themselves are
      // still Microsoft's; only their freshness lapsed. This lives inside the
      // shared promise so everyone waiting on the same request gets the same
      // answer, rather than the caller who happened to start it getting the
      // keys and the rest getting the error.
      if (previous) {
        logTeamsError(undefined, "JWKS refresh failed, using the cached key set", err);
        return previous.keys;
      }
      throw err;
    }
  }

  async function load(opts: { forceRefresh?: boolean } = {}): Promise<BotFrameworkKey[]> {
    const cached = cache;
    if (!opts.forceRefresh && cached && now() - cached.fetchedAt < JWKS_TTL_MS) {
      return cached.keys;
    }
    // Whoever arrives second rides the first one's request, forced or not.
    // A second concurrent fetch could only bring back the same document, and
    // a burst of forged deliveries must not become a burst of requests to
    // Microsoft.
    if (inFlight) return inFlight;
    // Inside the window we answer from whatever we already hold and touch the
    // network not at all, which makes an unrecognised `kid` an ordinary
    // `unknown-kid` rejection: the same bare 401 as a bad signature, so the
    // endpoint cannot be used to ask which keys we are holding.
    if (now() - lastFetchStartedAt < JWKS_REFRESH_COOLDOWN_MS) return cached?.keys ?? [];

    // Stamped before the request, not after: a fetch that hangs must not
    // leave the window open behind it.
    lastFetchStartedAt = now();
    const attempt = refresh(cached);
    inFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  }

  return {
    load,
    forget() {
      cache = null;
      inFlight = null;
      lastFetchStartedAt = Number.NEGATIVE_INFINITY;
    },
    prime(keys) {
      cache = { keys: [...keys], fetchedAt: now() };
      inFlight = null;
    },
  };
}

const botFrameworkKeys = createBotFrameworkKeyLoader({ fetchKeys: fetchBotFrameworkKeys });

/** Drop the cached JWKS, the in-flight fetch and the cooldown. Tests only. */
export function forgetBotFrameworkKeys(): void {
  botFrameworkKeys.forget();
}

/**
 * Seed the key cache so the webhook path can be exercised end to end without
 * reaching Microsoft. Refused in production: the whole surface trusts these
 * keys, so a runtime path that installs an arbitrary set is a forgery seam.
 */
export function primeBotFrameworkKeysForTests(keys: readonly BotFrameworkKey[]): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Bot Framework key priming is test-only");
  }
  botFrameworkKeys.prime(keys);
}

/**
 * The process-wide JWKS: cached for {@link JWKS_TTL_MS}, refetched at most
 * once per {@link JWKS_REFRESH_COOLDOWN_MS}, never twice at once.
 */
export function loadBotFrameworkKeys(
  opts: { forceRefresh: boolean } = { forceRefresh: false },
): Promise<BotFrameworkKey[]> {
  return botFrameworkKeys.load(opts);
}

async function fetchBotFrameworkKeys(): Promise<BotFrameworkKey[]> {
  const metaRes = await fetch(BOT_FRAMEWORK_OPENID_CONFIG_URL, {
    headers: { Accept: "application/json" },
  });
  if (!metaRes.ok) {
    throw new Error(`Bot Framework OpenID metadata ${metaRes.status} ${metaRes.statusText}`);
  }
  const meta = (await metaRes.json()) as { jwks_uri?: unknown };
  const jwksUri = typeof meta?.jwks_uri === "string" ? meta.jwks_uri : "";
  // The metadata document decides where we go for keys, so it only gets to
  // send us to an https URL.
  if (!jwksUri.startsWith("https://")) {
    throw new Error("Bot Framework OpenID metadata carries no https jwks_uri");
  }
  const keysRes = await fetch(jwksUri, { headers: { Accept: "application/json" } });
  if (!keysRes.ok) {
    throw new Error(`Bot Framework JWKS ${keysRes.status} ${keysRes.statusText}`);
  }
  const keys = parseJwks(await keysRes.json());
  if (keys.length === 0) throw new Error("Bot Framework JWKS carried no usable RSA keys");
  return keys;
}

// ---------- Normalization ----------

/**
 * `28:<appId>` and `28:orgid:<appId>` are the same bot wearing two of
 * Microsoft's prefixes, and which one arrives depends on the tenant. Compare
 * the part that identifies the app.
 */
export function sameBotId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return botIdCore(a) === botIdCore(b);
}

function botIdCore(id: string): string {
  return id.trim().toLowerCase().replace(/^28:/, "").replace(/^orgid:/, "");
}

/**
 * Remove Microsoft Teams mention markup.
 *
 * The paired form is what a real mention looks like (`<at>Finley</at>`) and
 * the whole thing goes, display name included — the employee should read the
 * question, not its own name. The second pass catches an unbalanced tag,
 * which a person can produce by typing one, and keeps the surrounding words.
 */
export function stripTeamsMentions(text: string): string {
  return text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " ").replace(/<\/?at\b[^>]*>/gi, " ");
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/**
 * Decode the handful of entities Microsoft Teams escapes on the way out.
 *
 * One pass, never two: decoding repeatedly would turn a literal `&amp;lt;`
 * that somebody typed into a `<`, and re-introducing markup the sender did
 * not write is exactly the trick the mention strip above exists to resist.
 */
export function decodeTeamsEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi,
    (match) => HTML_ENTITIES[match.toLowerCase()] ?? match,
  );
}

/** Mentions out, entities in, whitespace tidied — paragraph breaks survive. */
export function cleanTeamsText(text: string): string {
  return decodeTeamsEntities(stripTeamsMentions(text))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ids the message @-mentioned, in order. */
export function mentionedIds(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  const ids: string[] = [];
  for (const entry of entities) {
    const entity = asRecord(entry);
    if (!entity) continue;
    if (str(entity.type)?.toLowerCase() !== "mention") continue;
    const id = str(asRecord(entity.mentioned)?.id);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * One Bot Framework activity → one {@link InboundChatTurn}, or null when
 * there is nothing for an AI Employee to answer.
 *
 * Pure: the caller has already proved the activity came from Microsoft, and
 * everything decided here is translation.
 */
export function normalizeTeamsActivity(args: {
  activity: unknown;
  connectionId: string;
  companyId: string;
}): InboundChatTurn | null {
  const activity = asRecord(args.activity);
  if (!activity) return null;
  // `conversationUpdate`, `typing`, reactions, installs — all real traffic,
  // none of it a question.
  if (str(activity.type) !== "message") return null;

  const from = asRecord(activity.from);
  const conversation = asRecord(activity.conversation);
  if (!from || !conversation) return null;

  const fromId = str(from.id);
  if (!fromId) return null;
  const botId = str(asRecord(activity.recipient)?.id);
  // Our own message coming back at us. Either check alone is enough in
  // theory; together they close the loop even in a tenant that sends one of
  // the two prefixed forms of the bot id, and a bot-to-bot conversation is
  // not a thing this surface is for.
  if (str(from.role)?.toLowerCase() === "bot") return null;
  if (sameBotId(fromId, botId)) return null;

  const conversationId = str(conversation.id);
  if (!conversationId) return null;

  // Without a serviceUrl there is nowhere to answer, so the turn would be a
  // reply written into the void.
  const serviceUrl = normalizeServiceUrl(str(activity.serviceUrl) ?? "");
  if (!serviceUrl) return null;

  // A missing conversationType counts as a group: the stricter branch is the
  // one that demands an @-mention, so an activity shape we do not recognise
  // errs toward silence rather than toward answering everything in a channel.
  const group = str(conversation.conversationType) !== "personal" || conversation.isGroup === true;
  if (group) {
    const mentioned = mentionedIds(activity.entities).some((id) => sameBotId(id, botId));
    if (!mentioned) return null;
  }

  const text = cleanTeamsText(str(activity.text) ?? "");
  if (!text) return null;

  const activityId = str(activity.id);
  return {
    provider: "microsoft-teams",
    connectionId: args.connectionId,
    companyId: args.companyId,
    externalKey: conversationId,
    // `aadObjectId` is the Entra object id — the strong claim, stable across
    // renames and the same person in every Microsoft surface. `from.id` is a
    // per-bot channel handle and is only a fallback, notably for a guest whose
    // tenant does not expose an object id.
    externalUserId: str(from.aadObjectId) ?? fromId,
    externalUserLabel: str(from.name),
    threadTitle: deriveThreadTitle(activity, conversation),
    text,
    group,
    externalMessageId: activityId,
    replyTo: { conversationId, serviceUrl, activityId },
  };
}

function deriveThreadTitle(
  activity: Record<string, unknown>,
  conversation: Record<string, unknown>,
): string | null {
  const channelData = asRecord(activity.channelData);
  const team = str(asRecord(channelData?.team)?.name);
  const channel = str(asRecord(channelData?.channel)?.name);
  if (team && channel) return `${team} · ${channel}`;
  return channel ?? team ?? str(conversation.name);
}

// ---------- Adapter ----------

/** `Authorization: Bearer <jwt>`, or null when there is no usable one. */
export function bearerToken(headers: Record<string, string | undefined>): string | null {
  const raw = headers.authorization ?? headers.Authorization ?? "";
  const match = /^Bearer\s+([A-Za-z0-9._-]+)\s*$/i.exec(raw);
  return match ? match[1] : null;
}

export const microsoftTeamsChatSurface: ChatSurfaceAdapter = {
  provider: "microsoft-teams",
  transport: "webhook",
  requiresPublicUrl: true,
  textLimit: TEAMS_TEXT_LIMIT,

  async send({ connectionId, config, replyTo, text }) {
    const conversationId = str(replyTo.conversationId);
    const serviceUrl = normalizeServiceUrl(str(replyTo.serviceUrl) ?? "");
    if (!conversationId || !serviceUrl) {
      throw new Error("Microsoft Teams reply target is missing a conversationId or serviceUrl");
    }
    // The reply we are about to send proves the endpoint still works, so keep
    // it for the outbound tools.
    rememberServiceUrl(connectionId, serviceUrl);
    // Microsoft Teams threads on the conversation id — a channel reply carries
    // the parent message inside it — so the activity id rides along on
    // `replyTo` for provenance and takes no part in routing.
    await botFrameworkFetch({
      config: config as unknown as MicrosoftTeamsConfig,
      serviceUrl,
      path: `v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      method: "POST",
      body: { type: "message", text, textFormat: "markdown" },
    });
  },

  webhook: {
    async verifyAndNormalize({ connectionId, companyId, config, rawBody, headers }) {
      const appId = typeof config.appId === "string" ? config.appId.trim() : "";
      const token = bearerToken(headers);
      // No configured audience and no bearer are the same answer: this route
      // sits in front of the session middleware, so the token is the only
      // credential in the request and there is nothing else to fall back on.
      if (!appId || !token) return reject(401);

      let activity: unknown;
      try {
        activity = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Nothing to bind the token's serviceUrl claim to, and nothing to
        // normalize. 400 rather than 401 so an operator reading the access log
        // can tell a broken proxy apart from a rejected credential.
        return reject(400);
      }
      const serviceUrl = normalizeServiceUrl(str(asRecord(activity)?.serviceUrl) ?? "");

      let verified: BotFrameworkJwtResult;
      try {
        verified = await verifyBotFrameworkJwtWithKeyRefresh({
          token,
          appId,
          serviceUrl,
          loadKeys: loadBotFrameworkKeys,
        });
      } catch (err) {
        logTeamsError(connectionId, "could not load Bot Framework signing keys", err);
        return reject(401);
      }
      if (!verified.ok) {
        logTeamsError(connectionId, `rejected an activity: ${verified.reason}`);
        return reject(401);
      }

      // Verified, so the endpoint is Microsoft's own claim about itself. Learn
      // it even from an activity we will not answer — being added to a channel
      // is a `conversationUpdate`, and it is the first and sometimes only
      // chance to find out where that channel lives.
      if (serviceUrl) rememberServiceUrl(connectionId, serviceUrl);

      const turn = normalizeTeamsActivity({ activity, connectionId, companyId });
      return { kind: "turns", turns: turn ? [turn] : [] };
    },
  },
};

// ---------- Small helpers ----------

function reject(status: number): ChatSurfaceWebhookResult {
  return { kind: "reject", status };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function audienceMatches(aud: unknown, appId: string): boolean {
  if (typeof aud === "string") return aud === appId;
  if (Array.isArray(aud)) return aud.some((entry) => entry === appId);
  return false;
}

/** Decode one base64url JWT segment as a JSON object, or null. */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

function logTeamsError(connectionId: string | undefined, label: string, err?: unknown): void {
  const tag = connectionId ? `[microsoft-teams ${connectionId}]` : "[microsoft-teams]";
  const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`;
  // eslint-disable-next-line no-console
  console.error(`${tag} ${label}${detail}`);
}
