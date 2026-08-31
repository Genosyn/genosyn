import { Router } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { ExternalChatIdentity } from "../db/entities/ExternalChatIdentity.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import type { Role } from "../db/entities/Membership.js";
import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
  roleAtLeast,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { getChatSurfaceAdapter } from "../services/chatSurfaces/adapters.js";
import {
  bindIdentity,
  listIdentities,
  previewBind,
  unbindIdentity,
  type BindOutcome,
} from "../services/chatSurfaces/identity.js";
import type { ChatSurfaceAdapter } from "../services/chatSurfaces/types.js";
import { getPublicUrl, isPublicUrlConfigured } from "../services/publicUrl.js";
import { chatSurfaceWebhookUrl } from "./chatSurfaceWebhooks.js";

/**
 * The two authenticated halves of external chat surfaces (M59): the operator's
 * view of who is talking to the company's bots, and the one route a human hits
 * to prove which of those senders is them.
 *
 * They are separate routers because they are scoped differently, and the
 * difference is the point. Reading and cutting bindings is company work, so
 * `chatSurfacesRouter` mounts under `/api/companies/:cid`. *Claiming* a
 * binding cannot be, because the person following the link out of Slack has
 * not chosen a company yet — the identity row names the company, and the
 * session names the person. Requiring a `:cid` there would ask the human for
 * the one fact the link already knows.
 *
 * Neither router does any of the work. Identity lifecycle lives in
 * `services/chatSurfaces/identity.ts`, which is also where the rule that
 * matters is written down: a platform's claim about somebody's email is not
 * proof of Membership, so the only bind is a session-backed click.
 */
export const chatSurfacesRouter = Router({ mergeParams: true });
chatSurfacesRouter.use(requireAuth);
chatSurfacesRouter.use(requireCompanyMember);

/**
 * Admin-only paths, scoped rather than blanket.
 *
 * The identity *list* names which colleague is behind which Slack account —
 * an org chart of everyone's external handles, which is not something every
 * Member is entitled to enumerate. The webhook URL is deployment
 * configuration. Both are admin reads.
 *
 * `DELETE /chat-surfaces/identities/:id` is deliberately outside this list:
 * a person may always cut their own link, and the handler makes that call
 * itself. Hence the anchored regex — a plain string matcher would also cover
 * the child path and lock a Member out of their own binding.
 */
export const CHAT_SURFACE_ADMIN_PATHS = [
  /^\/chat-surfaces\/identities\/?$/,
  "/chat-surfaces/webhook-url",
] as const;

chatSurfacesRouter.use(onRoutePaths(["/chat-surfaces"], requireBrowserSession));
chatSurfacesRouter.use(onRoutePaths(CHAT_SURFACE_ADMIN_PATHS, requireCompanyRole("admin")));

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const identityParamsSchema = z
  .object({ cid: z.string().uuid(), id: z.string().uuid() })
  .strict();

/** Narrow the roster to one bot. Omitted means every surface in the company. */
export const identityListQuerySchema = z
  .object({ connectionId: z.string().uuid().optional() })
  .strict();

export const webhookUrlQuerySchema = z.object({ connectionId: z.string().uuid() }).strict();

chatSurfacesRouter.get(
  "/chat-surfaces/identities",
  validateParams(companyParamsSchema),
  validateQuery(identityListQuerySchema),
  async (req, res, next) => {
    try {
      const { connectionId } = req.query as unknown as z.infer<typeof identityListQuerySchema>;
      res.json({
        identities: await listIdentities({ companyId: req.params.cid, connectionId }),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Who is allowed to cut a binding.
 *
 * Two principals, for two different reasons. An admin, because a binding is
 * standing authority to act as a Member from outside Genosyn and revoking
 * standing authority is an admin's job. And the bound Member themselves,
 * because somebody who wants to unlink their own Slack account from their own
 * account should never have to file a request to do it.
 *
 * A Member who is not the bound one gets nothing — that would be revoking a
 * colleague's access.
 */
export function canUnbindIdentity(args: {
  role: Role | undefined;
  actorUserId: string | null;
  boundUserId: string | null;
}): boolean {
  // No resolved role means the request never proved Membership. The router
  // guarantees it did, and this refuses anyway rather than letting a future
  // remount decide the question by accident.
  if (!args.role) return false;
  if (roleAtLeast("admin", args.role)) return true;
  // Two nulls are not a match: an unbound row belongs to nobody, so nobody
  // gets to claim it by having no id either.
  return Boolean(args.actorUserId) && args.actorUserId === args.boundUserId;
}

chatSurfacesRouter.delete(
  "/chat-surfaces/identities/:id",
  validateParams(identityParamsSchema),
  async (req, res, next) => {
    try {
      const { cid, id } = req.params as unknown as z.infer<typeof identityParamsSchema>;
      const identity = await AppDataSource.getRepository(ExternalChatIdentity).findOneBy({
        id,
        companyId: cid,
      });
      if (!identity) return res.status(404).json({ error: "Not found" });
      const actorUserId = req.userId ?? null;
      if (
        !canUnbindIdentity({
          role: req.companyRole,
          actorUserId,
          boundUserId: identity.userId,
        })
      ) {
        return res.status(403).json({ error: "admin company role required" });
      }

      const boundUserId = identity.userId;
      const unbound = await unbindIdentity({ companyId: cid, identityId: id });
      if (!unbound) return res.status(404).json({ error: "Not found" });

      // Audited because this changes who can act with the company's authority
      // from outside Genosyn. An external binding is revoked far less often
      // than it is used, so the revocation is the event worth being able to
      // find later.
      await recordAudit({
        companyId: cid,
        actorUserId,
        action: "chat_surface.identity.unbind",
        targetType: "external_chat_identity",
        targetId: unbound.id,
        targetLabel: unbound.externalUserLabel ?? unbound.externalUserId,
        metadata: {
          provider: unbound.provider,
          connectionId: unbound.connectionId,
          unboundUserId: boundUserId,
          self: Boolean(boundUserId) && boundUserId === actorUserId,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export type ChatSurfaceWebhookEndpoint = {
  provider: string;
  connectionId: string;
  url: string;
  /** False when the surface cannot receive anything until an operator sets one. */
  publicUrlConfigured: boolean;
  requiresPublicUrl: boolean;
  /** False for a poll- or socket-only surface, where the URL is decoration. */
  supportsWebhook: boolean;
};

/**
 * What the Integrations screen needs to tell an operator to paste this URL —
 * or to tell them it will not work yet.
 *
 * `publicUrlConfigured` is separate from the URL itself because the URL is
 * always renderable: with no configured public URL it comes out as
 * `http://localhost:…`, which is a perfectly valid string and a completely
 * useless thing to give Meta. The operator needs to see both.
 */
export function describeWebhookEndpoint(args: {
  publicUrl: string;
  publicUrlConfigured: boolean;
  connection: { id: string; provider: string };
  adapter: Pick<ChatSurfaceAdapter, "requiresPublicUrl" | "webhook">;
}): ChatSurfaceWebhookEndpoint {
  return {
    provider: args.connection.provider,
    connectionId: args.connection.id,
    url: chatSurfaceWebhookUrl(args.publicUrl, args.connection.provider, args.connection.id),
    publicUrlConfigured: args.publicUrlConfigured,
    requiresPublicUrl: args.adapter.requiresPublicUrl,
    supportsWebhook: Boolean(args.adapter.webhook),
  };
}

chatSurfacesRouter.get(
  "/chat-surfaces/webhook-url",
  validateParams(companyParamsSchema),
  validateQuery(webhookUrlQuerySchema),
  async (req, res, next) => {
    try {
      const { connectionId } = req.query as unknown as z.infer<typeof webhookUrlQuerySchema>;
      const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: connectionId,
        companyId: req.params.cid,
      });
      if (!connection) return res.status(404).json({ error: "Not found" });
      const adapter = getChatSurfaceAdapter(connection.provider);
      if (!adapter) return res.status(404).json({ error: "Not a chat surface" });
      res.json(
        describeWebhookEndpoint({
          publicUrl: getPublicUrl(),
          publicUrlConfigured: isPublicUrlConfigured(),
          connection,
          adapter,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The bind surface. Session-scoped and nothing more.
 *
 * Mounted at `/api`, so every middleware is attached to the route rather than
 * to the router: a `.use()` here would also run on the routes of every other
 * router sharing that mount.
 */
export const chatSurfaceBindRouter = Router();

export const bindBodySchema = z
  .object({
    identityId: z.string().uuid(),
    // The token is opaque and generated by us, but it arrives from a URL a
    // human pasted, so it is bounded like any other untrusted string.
    token: z.string().min(1).max(512),
  })
  .strict();

export type BindFailureReason = Extract<BindOutcome, { ok: false }>["reason"];

/**
 * Every way a bind can fail, and what the browser is told.
 *
 * Typed as a total `Record` over the service's own union on purpose: adding a
 * reason in `identity.ts` breaks this build instead of falling through to a
 * status nobody chose. The four statuses are distinct because the page that
 * shows them has four genuinely different things to say — an expired link can
 * be replaced by sending another message, a forbidden one never can.
 */
const BIND_FAILURES: Record<BindFailureReason, { status: number; error: string }> = {
  not_found: {
    status: 404,
    error: "This link isn't valid. Message the AI Employee again to get a new one.",
  },
  expired: {
    status: 410,
    error: "This link has expired. Message the AI Employee again to get a new one.",
  },
  already_bound: {
    status: 409,
    error: "That chat account is already linked to a different Member.",
  },
  forbidden: {
    status: 403,
    error: "You aren't a Member of the company this chat belongs to.",
  },
};

export const BIND_FAILURE_REASONS = Object.keys(BIND_FAILURES) as BindFailureReason[];

/**
 * A reason with no entry is a bug, not a success. It answers 400 rather than
 * falling through to the 200 the caller would otherwise write.
 *
 * `Object.hasOwn` rather than a lookup-and-default, because a plain object
 * answers `__proto__` and `constructor` with something truthy — a default that
 * only fires on `undefined` would hand back `Object.prototype` and then read a
 * `status` of `undefined` off it.
 */
export function bindFailureResponse(reason: string): { status: number; error: string } {
  if (Object.hasOwn(BIND_FAILURES, reason)) {
    return BIND_FAILURES[reason as BindFailureReason];
  }
  return { status: 400, error: "This link could not be used." };
}

export function serializeBoundIdentity(identity: ExternalChatIdentity): {
  id: string;
  provider: string;
  connectionId: string;
  externalUserLabel: string | null;
  boundAt: string | null;
} {
  return {
    id: identity.id,
    provider: identity.provider,
    connectionId: identity.connectionId,
    externalUserLabel: identity.externalUserLabel,
    boundAt: identity.boundAt ? identity.boundAt.toISOString() : null,
  };
}

/**
 * What the link would do, before it does it.
 *
 * The bind used to happen on page load, which made a URL enough on its own to
 * attach the opener's authority to whichever external account minted it —
 * exactly the shape of a confused deputy, and a link is the easiest thing in
 * the world to forward. This route lets the page name the account first, so
 * the human confirming has something to refuse. It reads with the same token
 * the bind uses and deliberately does not spend it.
 */
chatSurfaceBindRouter.post(
  "/chat-surfaces/bind/preview",
  requireAuth,
  requireBrowserSession,
  validateBody(bindBodySchema),
  async (req, res, next) => {
    try {
      const { identityId, token } = req.body as z.infer<typeof bindBodySchema>;
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const outcome = await previewBind({ identityId, token, userId });
      if (!outcome.ok) {
        const failure = bindFailureResponse(outcome.reason);
        return res.status(failure.status).json({ error: failure.error });
      }
      res.json({ ok: true, preview: outcome.preview });
    } catch (err) {
      next(err);
    }
  },
);

chatSurfaceBindRouter.post(
  "/chat-surfaces/bind",
  requireAuth,
  // Spelled out rather than left to `requireAuth`'s bearer rules: this route
  // exists so that a browser session proves who somebody is, and an API key
  // is a company credential that proves nothing about who is holding it.
  requireBrowserSession,
  validateBody(bindBodySchema),
  async (req, res, next) => {
    try {
      const { identityId, token } = req.body as z.infer<typeof bindBodySchema>;
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      // The Member being bound is whoever holds this session — never a field
      // in the body. A payload-supplied user id would let anyone with a link
      // hand a stranger's Slack account the company's authority.
      const outcome = await bindIdentity({ identityId, token, userId });
      if (!outcome.ok) {
        const failure = bindFailureResponse(outcome.reason);
        return res.status(failure.status).json({ error: failure.error });
      }

      await recordAudit({
        companyId: outcome.identity.companyId,
        actorUserId: userId,
        action: "chat_surface.identity.bind",
        targetType: "external_chat_identity",
        targetId: outcome.identity.id,
        targetLabel: outcome.identity.externalUserLabel ?? outcome.identity.externalUserId,
        metadata: {
          provider: outcome.identity.provider,
          connectionId: outcome.identity.connectionId,
          boundVia: outcome.identity.boundVia,
        },
      });
      res.json({ ok: true, identity: serializeBoundIdentity(outcome.identity) });
    } catch (err) {
      next(err);
    }
  },
);
