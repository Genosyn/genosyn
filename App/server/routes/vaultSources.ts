import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";

import { requireCompanyRole } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { VaultError, syncVaultSource } from "../services/vault.js";
import {
  VaultSourceError,
  createVaultSource,
  deleteVaultSource,
  getVaultSource,
  listVaultSources,
  updateVaultSource,
} from "../services/vaultSources.js";

/**
 * Vault sources — connecting a company's Bitwarden or Vaultwarden vault.
 *
 * Mounted inside the Vault router, so it inherits that surface's guards: no AI
 * Browser, no API key, no caching. Every route here is admin-gated on top of
 * that, because a source holds the master password to an entire external
 * vault; reading it is a bigger act than reading any single Vault item.
 */
export const vaultSourcesRouter = Router({ mergeParams: true });

vaultSourcesRouter.use(requireCompanyRole("admin"));

type VaultSourceRequest = Request & { userId: string };

type AsyncHandler = (req: VaultSourceRequest, res: Response) => Promise<unknown>;

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req as VaultSourceRequest, res).catch((error) => sendError(error, res, next));
  };
}

function sendError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof VaultSourceError || error instanceof VaultError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  next(error);
}

function companyId(req: VaultSourceRequest): string {
  return req.params.cid;
}

const companyParamsSchema = z.object({ cid: z.string().uuid() });
const sourceParamsSchema = companyParamsSchema.extend({ sourceId: z.string().uuid() });

const serverUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(candidate);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "Enter the web vault URL, for example https://vault.example.com");

const createSourceSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    serverUrl: serverUrlSchema,
    email: z.string().trim().min(3).max(320),
    masterPassword: z.string().min(1).max(1024),
    clientId: z.string().trim().max(200).default(""),
    clientSecret: z.string().trim().max(400).default(""),
    scopeName: z.string().trim().max(200).default(""),
    defaultVisibility: z.enum(["company", "restricted"]).default("restricted"),
    twoFactorCode: z.string().trim().min(6).max(12).optional(),
  })
  .strict()
  .refine((body) => Boolean(body.clientId) === Boolean(body.clientSecret), {
    message: "A Bitwarden API key needs both its client id and its client secret",
    path: ["clientSecret"],
  });

const updateSourceSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    serverUrl: serverUrlSchema.optional(),
    email: z.string().trim().min(3).max(320).optional(),
    masterPassword: z.string().min(1).max(1024).optional(),
    clientId: z.string().trim().max(200).optional(),
    clientSecret: z.string().trim().max(400).optional(),
    scopeName: z.string().trim().max(200).optional(),
    defaultVisibility: z.enum(["company", "restricted"]).optional(),
    twoFactorCode: z.string().trim().min(6).max(12).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update");

vaultSourcesRouter.get(
  "/",
  validateParams(companyParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({ sources: await listVaultSources(companyId(req)) });
  }),
);

vaultSourcesRouter.post(
  "/",
  validateParams(companyParamsSchema),
  validateBody(createSourceSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSourceSchema>;
    const source = await createVaultSource({
      companyId: companyId(req),
      actorUserId: req.userId,
      input: body,
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.source.connect",
      targetType: "vault_source",
      targetId: source.id,
      targetLabel: source.label,
      metadata: {
        kind: source.kind,
        serverUrl: source.serverUrl,
        usesApiKey: source.usesApiKey,
        defaultVisibility: source.defaultVisibility,
      },
    });
    // Connecting is only half of what the operator asked for; mirror the items
    // now rather than leaving an empty source until the next button press. A
    // failure here has already been recorded on the row, and the source itself
    // is real and reconnectable, so it must not undo the create.
    let result = null;
    try {
      result = await syncVaultSource({ companyId: companyId(req), sourceId: source.id });
    } catch {
      result = null;
    }
    res.status(201).json({
      source: await getVaultSource(companyId(req), source.id),
      result,
    });
  }),
);

vaultSourcesRouter.patch(
  "/:sourceId",
  validateParams(sourceParamsSchema),
  validateBody(updateSourceSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSourceSchema>;
    const source = await updateVaultSource({
      companyId: companyId(req),
      sourceId: req.params.sourceId,
      patch: body,
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.source.update",
      targetType: "vault_source",
      targetId: source.id,
      targetLabel: source.label,
      // Field names only — never a value, and never whether one was blank.
      metadata: { fields: Object.keys(body).filter((field) => field !== "twoFactorCode") },
    });
    res.json({ source });
  }),
);

vaultSourcesRouter.delete(
  "/:sourceId",
  validateParams(sourceParamsSchema),
  asyncHandler(async (req, res) => {
    const removed = await deleteVaultSource({
      companyId: companyId(req),
      sourceId: req.params.sourceId,
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.source.disconnect",
      targetType: "vault_source",
      targetId: removed.id,
      targetLabel: removed.label,
      metadata: { removedItems: removed.removedItems },
    });
    res.json({ ok: true, removedItems: removed.removedItems });
  }),
);

vaultSourcesRouter.post(
  "/:sourceId/sync",
  validateParams(sourceParamsSchema),
  asyncHandler(async (req, res) => {
    const result = await syncVaultSource({
      companyId: companyId(req),
      sourceId: req.params.sourceId,
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.source.sync",
      targetType: "vault_source",
      targetId: req.params.sourceId,
      targetLabel: "Vault source",
      metadata: {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        itemCount: result.itemCount,
      },
    });
    res.json({
      result,
      source: await getVaultSource(companyId(req), req.params.sourceId),
    });
  }),
);
