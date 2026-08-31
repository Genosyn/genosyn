import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { ExternalChatIdentity } from "../../db/entities/ExternalChatIdentity.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { constantTimeEqual } from "../../lib/constantTime.js";
import { generateToken, hashToken } from "../../lib/token.js";
import { getPublicUrl } from "../publicUrl.js";
import type { ChatSurfaceProviderId } from "./types.js";

/**
 * Who is on the other end of an external chat surface, and what that buys
 * them.
 *
 * The rule this module exists to enforce: **a platform's own claim about
 * someone's email is not proof they are a Member of this company.** Slack
 * Connect and Teams federation both put people from other tenants in the
 * same conversation as colleagues, with a verified address their own tenant
 * vouched for. Matching on it would hand a stranger the company's tools. So
 * the only bind is a one-time link the human opens in a browser where they
 * are already signed in to Genosyn — the session is the proof, and Genosyn
 * already knows how to check a session.
 *
 * Everything here is deliberately cheap to revoke: unbind clears `userId`,
 * and losing the Membership fails {@link resolveBoundRequester} on the very
 * next turn without anyone having to remember to clean up.
 */

/** How long a bind link is good for. Short: the human is mid-conversation. */
export const BIND_LINK_TTL_MS = 15 * 60 * 1000;

export type ChatSurfaceRequester = {
  userId: string;
  sessionVersion: number;
};

function repo() {
  return AppDataSource.getRepository(ExternalChatIdentity);
}

/**
 * Upsert the row for one external sender. Called on every inbound turn, so it
 * doubles as the "last seen" clock and keeps the display label fresh when
 * somebody changes their Slack name.
 */
export async function recordSighting(args: {
  companyId: string;
  provider: ChatSurfaceProviderId;
  connectionId: string;
  externalUserId: string;
  externalUserLabel: string | null;
}): Promise<ExternalChatIdentity> {
  const identities = repo();
  const existing = await identities.findOneBy({
    connectionId: args.connectionId,
    externalUserId: args.externalUserId,
  });
  if (existing) {
    existing.lastSeenAt = new Date();
    if (args.externalUserLabel && args.externalUserLabel !== existing.externalUserLabel) {
      existing.externalUserLabel = args.externalUserLabel;
    }
    // A Connection can be moved between companies only by deleting it, so a
    // drift here means a stale row from a reused id — re-point it rather than
    // letting it authorize against the wrong company.
    if (existing.companyId !== args.companyId) {
      existing.companyId = args.companyId;
      existing.userId = null;
      existing.boundAt = null;
      existing.boundVia = null;
      existing.boundSessionVersion = null;
    }
    return identities.save(existing);
  }
  return identities.save(
    identities.create({
      companyId: args.companyId,
      provider: args.provider,
      connectionId: args.connectionId,
      externalUserId: args.externalUserId,
      externalUserLabel: args.externalUserLabel,
      userId: null,
      boundAt: null,
      boundVia: null,
      boundSessionVersion: null,
      linkTokenHash: null,
      linkExpiresAt: null,
      lastSeenAt: new Date(),
    }),
  );
}

/**
 * Turn a bound identity into the delegation `chatWithEmployee` wants, or null
 * when the binding no longer buys anything.
 *
 * Re-checked every turn on purpose. A Member removed from the company keeps
 * their Slack account and their DM history; what they must not keep is the
 * company's authority.
 */
export async function resolveBoundRequester(
  identity: ExternalChatIdentity,
): Promise<ChatSurfaceRequester | null> {
  if (!identity.userId) return null;
  const [membership, user] = await Promise.all([
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: identity.companyId,
      userId: identity.userId,
    }),
    AppDataSource.getRepository(User).findOneBy({ id: identity.userId }),
  ]);
  if (!membership || !user) return null;
  // The epoch is compared, not re-read. Reading `user.sessionVersion` here and
  // handing it straight to `chatWithEmployee` would satisfy that function's
  // auth-epoch check with a value derived from the thing it is checking, which
  // is no check at all — and would leave a password reset or a "sign out
  // everywhere" with no effect on a surface that is not a browser session.
  if (identity.boundSessionVersion !== user.sessionVersion) return null;
  return { userId: user.id, sessionVersion: identity.boundSessionVersion };
}

/**
 * Mint (or re-mint) the single-use bind link for a pending identity.
 *
 * Re-minting on every unbound turn is intentional: the alternative is a human
 * who lost the first message being stuck, and the token is single-use and
 * short-lived either way.
 */
export async function mintBindLink(identity: ExternalChatIdentity): Promise<string> {
  const token = generateToken(32);
  identity.linkTokenHash = hashToken(token);
  identity.linkExpiresAt = new Date(Date.now() + BIND_LINK_TTL_MS);
  await repo().save(identity);
  return `${getPublicUrl()}/link-chat/${identity.id}/${token}`;
}

export type BindFailure = { ok: false; reason: "not_found" | "expired" | "already_bound" | "forbidden" };
export type BindOutcome = { ok: true; identity: ExternalChatIdentity } | BindFailure;

/**
 * Everything both the preview and the bind have to agree about.
 *
 * They must agree exactly: a preview that accepted a link the bind then
 * refuses sends somebody back to the chat for a replacement they did not
 * need, and — worse — a preview that refused one the bind would take would
 * hide from the reader what they are about to authorize.
 */
async function resolveBindCandidate(args: {
  identityId: string;
  token: string;
  userId: string;
}): Promise<{ ok: true; identity: ExternalChatIdentity } | BindFailure> {
  const identity = await repo().findOneBy({ id: args.identityId });
  // One shape for "no such row" and "wrong token" so the endpoint cannot be
  // used to enumerate which identity ids exist.
  if (!identity || !identity.linkTokenHash) return { ok: false, reason: "not_found" };
  if (!constantTimeEqual(hashToken(args.token), identity.linkTokenHash)) {
    return { ok: false, reason: "not_found" };
  }
  if (!identity.linkExpiresAt || identity.linkExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (identity.userId && identity.userId !== args.userId) {
    return { ok: false, reason: "already_bound" };
  }
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId: identity.companyId,
    userId: args.userId,
  });
  if (!membership) return { ok: false, reason: "forbidden" };
  return { ok: true, identity };
}

export type BindPreview = {
  identityId: string;
  provider: string;
  /** The external account this link would speak for, so a reader can refuse. */
  externalUserLabel: string | null;
  externalUserId: string;
  companyName: string;
  /** True when this Member already holds this binding and is just re-proving. */
  alreadyMine: boolean;
};

export type BindPreviewOutcome = { ok: true; preview: BindPreview } | BindFailure;

/**
 * What a link would do, without doing it.
 *
 * This exists because a bind performed on page load is a confused deputy: a
 * link is a thing one person can send another, and the person who opens it is
 * the one whose authority gets attached to somebody else's chat account.
 * Naming the account before the click is what turns "you opened a URL" into
 * "you agreed to something" — so the reader can see an external handle they do
 * not recognise and close the tab.
 *
 * Deliberately does not consume the token: a preview that burned it would make
 * the confirmation step impossible.
 */
export async function previewBind(args: {
  identityId: string;
  token: string;
  userId: string;
}): Promise<BindPreviewOutcome> {
  const candidate = await resolveBindCandidate(args);
  if (!candidate.ok) return candidate;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: candidate.identity.companyId,
  });
  return {
    ok: true,
    preview: {
      identityId: candidate.identity.id,
      provider: candidate.identity.provider,
      externalUserLabel: candidate.identity.externalUserLabel,
      externalUserId: candidate.identity.externalUserId,
      companyName: company?.name ?? "this company",
      alreadyMine: candidate.identity.userId === args.userId,
    },
  };
}

/**
 * Complete a bind. `userId` comes from the browser session of whoever opened
 * the link, never from the payload — the caller is an authenticated route.
 */
export async function bindIdentity(args: {
  identityId: string;
  token: string;
  userId: string;
}): Promise<BindOutcome> {
  const candidate = await resolveBindCandidate(args);
  if (!candidate.ok) return candidate;
  const { identity } = candidate;

  const user = await AppDataSource.getRepository(User).findOneBy({ id: args.userId });
  if (!user) return { ok: false, reason: "forbidden" };

  // Burning the token is a conditional UPDATE rather than a save, so
  // "single-use" survives two browsers redeeming the same link at the same
  // instant: both read a live token above, and exactly one of them changes a
  // row here. Losing that race is indistinguishable from arriving second with
  // a spent link, which is what it is.
  const burned = await repo()
    .createQueryBuilder()
    .update()
    .set({
      userId: args.userId,
      boundAt: new Date(),
      boundVia: "link",
      boundSessionVersion: user.sessionVersion,
      linkTokenHash: null,
      linkExpiresAt: null,
    })
    .where("id = :id AND linkTokenHash = :hash", {
      id: identity.id,
      hash: identity.linkTokenHash,
    })
    .execute();
  if ((burned.affected ?? 0) === 0) return { ok: false, reason: "not_found" };

  const saved = await repo().findOneBy({ id: identity.id });
  if (!saved) return { ok: false, reason: "not_found" };
  return { ok: true, identity: saved };
}

/**
 * Drop a binding. The row survives so the sender keeps a stable label and can
 * bind again; what goes is the authority.
 */
export async function unbindIdentity(args: {
  companyId: string;
  identityId: string;
}): Promise<ExternalChatIdentity | null> {
  const identities = repo();
  const identity = await identities.findOneBy({
    id: args.identityId,
    companyId: args.companyId,
  });
  if (!identity) return null;
  identity.userId = null;
  identity.boundAt = null;
  identity.boundVia = null;
  identity.boundSessionVersion = null;
  identity.linkTokenHash = null;
  identity.linkExpiresAt = null;
  return identities.save(identity);
}

export type ExternalChatIdentitySummary = {
  id: string;
  provider: string;
  connectionId: string;
  externalUserId: string;
  externalUserLabel: string | null;
  bound: boolean;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  boundAt: string | null;
  lastSeenAt: string | null;
};

/** Everyone who has ever messaged this company's bots, bound or not. */
export async function listIdentities(args: {
  companyId: string;
  connectionId?: string;
}): Promise<ExternalChatIdentitySummary[]> {
  const rows = await repo().find({
    where: args.connectionId
      ? { companyId: args.companyId, connectionId: args.connectionId }
      : { companyId: args.companyId },
    order: { lastSeenAt: "DESC" },
  });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await AppDataSource.getRepository(User).findBy({ id: In(userIds) })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((row) => {
    const user = row.userId ? byId.get(row.userId) : undefined;
    return {
      id: row.id,
      provider: row.provider,
      connectionId: row.connectionId,
      externalUserId: row.externalUserId,
      externalUserLabel: row.externalUserLabel,
      bound: Boolean(row.userId),
      userId: row.userId,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      boundAt: row.boundAt ? row.boundAt.toISOString() : null,
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    };
  });
}

/** Remove every identity for a Connection that is going away. */
export async function deleteIdentitiesForConnection(connectionId: string): Promise<void> {
  await repo().delete({ connectionId });
}
