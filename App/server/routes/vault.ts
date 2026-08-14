import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";

import type { EmployeeVaultAccessLevel } from "../db/entities/EmployeeVaultGrant.js";
import type { VaultMemberAccessLevel } from "../db/entities/VaultItemMemberAccess.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import {
  VaultError,
  createVaultItem,
  deleteEmployeeVaultGrant,
  deleteVaultItem,
  deleteVaultMemberAccess,
  getVaultItem,
  listEmployeeVaultGrantCandidates,
  listEmployeeVaultGrants,
  listVaultItems,
  listVaultMemberAccess,
  listVaultMemberAccessCandidates,
  revealVaultItem,
  updateEmployeeVaultGrant,
  updateVaultItem,
  updateVaultMemberAccess,
  upsertEmployeeVaultGrant,
  upsertVaultMemberAccess,
  type VaultHumanActor,
} from "../services/vault.js";

/**
 * Human-facing company Vault API. The legacy Settings → Secrets surface stays
 * separate: Vault items are structured credentials with item-level human
 * Access and AI Employee Grants, and are never injected wholesale into Runs.
 */
export const vaultRouter = Router({ mergeParams: true });

vaultRouter.use((req, res, next) => {
  if (req.get(AI_BROWSER_REQUEST_HEADER) === AI_BROWSER_REQUEST_VALUE) {
    return res.status(403).json({
      error:
        "The human Vault API is unavailable inside an AI Browser. Use item-level Vault Grants and governed Browser autofill.",
    });
  }
  next();
});
vaultRouter.use(requireAuth);
vaultRouter.use(requireCompanyMember);
vaultRouter.use((req, res, next) => {
  if (req.apiKey) {
    return res.status(403).json({
      error: "Vault access requires a logged-in browser session",
    });
  }
  // Decrypted metadata is sensitive too. This also covers every reveal error
  // path, so proxies and browsers never cache a plaintext response.
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
  next();
});

type VaultRequest = Request & {
  companyRole: NonNullable<Request["companyRole"]>;
  userId: string;
};

type AsyncHandler = (req: VaultRequest, res: Response) => Promise<unknown>;

function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    void handler(req as VaultRequest, res).catch((error) => sendError(error, res, next));
  };
}

function sendError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof VaultError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  next(error);
}

function companyId(req: VaultRequest): string {
  return req.params.cid;
}

function actor(req: VaultRequest): VaultHumanActor {
  return { userId: req.userId, role: req.companyRole };
}

const companyParamsSchema = z.object({ cid: z.string().uuid() });
const itemParamsSchema = z.object({
  cid: z.string().uuid(),
  itemId: z.string().uuid(),
});
const memberAccessParamsSchema = itemParamsSchema.extend({ accessId: z.string().uuid() });
const employeeGrantParamsSchema = itemParamsSchema.extend({ grantId: z.string().uuid() });

const itemTypeSchema = z.enum(["login", "api_key", "secure_note"]);
const visibilitySchema = z.enum(["company", "restricted"]);
const websiteUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "Enter an absolute http(s) URL without embedded credentials");

const createItemSchema = z
  .object({
    type: itemTypeSchema,
    visibility: visibilitySchema.default("restricted"),
    title: z.string().trim().min(1).max(200),
    username: z.string().max(500).default(""),
    secret: z.string().min(1).max(20_000),
    websiteUrl: websiteUrlSchema.default(""),
    notes: z.string().max(20_000).default(""),
  })
  .strict();

const updateItemSchema = z
  .object({
    type: itemTypeSchema.optional(),
    visibility: visibilitySchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    username: z.string().max(500).optional(),
    secret: z.string().min(1).max(20_000).optional(),
    websiteUrl: websiteUrlSchema.optional(),
    notes: z.string().max(20_000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).some((field) => field !== "expectedVersion"),
    "Provide at least one field to update",
  );

const revealSchema = z
  .object({
    purpose: z.enum(["reveal", "copy"]),
  })
  .strict();

const createMemberAccessSchema = z
  .object({
    userId: z.string().uuid(),
    accessLevel: z.enum(["view", "edit"]),
  })
  .strict();
const updateMemberAccessSchema = z.object({ accessLevel: z.enum(["view", "edit"]) }).strict();
const createEmployeeGrantSchema = z
  .object({
    employeeId: z.string().uuid(),
    accessLevel: z.enum(["use", "manage"]),
  })
  .strict();
const updateEmployeeGrantSchema = z.object({ accessLevel: z.enum(["use", "manage"]) }).strict();

vaultRouter.get(
  "/items",
  validateParams(companyParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({ items: await listVaultItems(companyId(req), actor(req)) });
  }),
);

vaultRouter.post(
  "/items",
  validateParams(companyParamsSchema),
  validateBody(createItemSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createItemSchema>;
    const item = await createVaultItem({
      companyId: companyId(req),
      actor: actor(req),
      type: body.type,
      visibility: body.visibility,
      payload: {
        title: body.title,
        username: body.username,
        secret: body.secret,
        websiteUrl: body.websiteUrl,
        notes: body.notes,
      },
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.item.create",
      targetType: "vault_item",
      targetId: item.id,
      targetLabel: "Vault item",
      metadata: { type: item.type, visibility: item.visibility },
    });
    res.status(201).json({ item });
  }),
);

vaultRouter.get(
  "/items/:itemId",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await getVaultItem(companyId(req), req.params.itemId, actor(req)) });
  }),
);

vaultRouter.patch(
  "/items/:itemId",
  validateParams(itemParamsSchema),
  validateBody(updateItemSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateItemSchema>;
    const { expectedVersion, ...patch } = body;
    const result = await updateVaultItem({
      companyId: companyId(req),
      itemId: req.params.itemId,
      actor: actor(req),
      expectedVersion,
      patch,
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: patch.secret !== undefined ? "vault.item.rotate" : "vault.item.update",
      targetType: "vault_item",
      targetId: result.item.id,
      targetLabel: "Vault item",
      metadata: {
        changedFields: Object.keys(patch),
        previousType: result.before.type,
        previousVisibility: result.before.visibility,
        type: result.item.type,
        visibility: result.item.visibility,
      },
    });
    res.json({ item: result.item });
  }),
);

vaultRouter.delete(
  "/items/:itemId",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    const deleted = await deleteVaultItem({
      companyId: companyId(req),
      itemId: req.params.itemId,
      actor: actor(req),
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: "vault.item.delete",
      targetType: "vault_item",
      targetId: deleted.id,
      targetLabel: "Vault item",
      metadata: { type: deleted.type },
    });
    res.json({ ok: true });
  }),
);

vaultRouter.post(
  "/items/:itemId/reveal",
  validateParams(itemParamsSchema),
  validateBody(revealSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof revealSchema>;
    const revealed = await revealVaultItem({
      companyId: companyId(req),
      itemId: req.params.itemId,
      actor: actor(req),
    });
    await recordAudit({
      companyId: companyId(req),
      actorUserId: req.userId,
      action: body.purpose === "copy" ? "vault.item.copy" : "vault.item.reveal",
      targetType: "vault_item",
      targetId: revealed.item.id,
      targetLabel: "Vault item",
      metadata: { purpose: body.purpose },
    });
    res.json({ secret: revealed.secret });
  }),
);

vaultRouter.get(
  "/items/:itemId/member-access",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({
      access: await listVaultMemberAccess({
        companyId: companyId(req),
        itemId: req.params.itemId,
        actor: actor(req),
      }),
    });
  }),
);

vaultRouter.get(
  "/items/:itemId/member-access-candidates",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({
      candidates: await listVaultMemberAccessCandidates({
        companyId: companyId(req),
        itemId: req.params.itemId,
        actor: actor(req),
      }),
    });
  }),
);

vaultRouter.post(
  "/items/:itemId/member-access",
  validateParams(itemParamsSchema),
  validateBody(createMemberAccessSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createMemberAccessSchema>;
    const access = await upsertVaultMemberAccess({
      companyId: companyId(req),
      itemId: req.params.itemId,
      actor: actor(req),
      userId: body.userId,
      accessLevel: body.accessLevel,
    });
    await auditMemberAccess(
      req,
      "upsert",
      access.id,
      access.userId,
      access.accessLevel,
      access.member.name,
    );
    res.json({ access });
  }),
);

vaultRouter.patch(
  "/items/:itemId/member-access/:accessId",
  validateParams(memberAccessParamsSchema),
  validateBody(updateMemberAccessSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateMemberAccessSchema>;
    const access = await updateVaultMemberAccess({
      companyId: companyId(req),
      itemId: req.params.itemId,
      accessId: req.params.accessId,
      actor: actor(req),
      accessLevel: body.accessLevel,
    });
    await auditMemberAccess(
      req,
      "update",
      access.id,
      access.userId,
      access.accessLevel,
      access.member.name,
    );
    res.json({ access });
  }),
);

vaultRouter.delete(
  "/items/:itemId/member-access/:accessId",
  validateParams(memberAccessParamsSchema),
  asyncHandler(async (req, res) => {
    const deleted = await deleteVaultMemberAccess({
      companyId: companyId(req),
      itemId: req.params.itemId,
      accessId: req.params.accessId,
      actor: actor(req),
    });
    await auditMemberAccess(
      req,
      "delete",
      deleted.id,
      deleted.userId,
      deleted.accessLevel,
      deleted.userId,
    );
    res.json({ ok: true });
  }),
);

vaultRouter.get(
  "/items/:itemId/employee-grants",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({
      grants: await listEmployeeVaultGrants({
        companyId: companyId(req),
        itemId: req.params.itemId,
        actor: actor(req),
      }),
    });
  }),
);

vaultRouter.get(
  "/items/:itemId/employee-grant-candidates",
  validateParams(itemParamsSchema),
  asyncHandler(async (req, res) => {
    res.json({
      candidates: await listEmployeeVaultGrantCandidates({
        companyId: companyId(req),
        itemId: req.params.itemId,
        actor: actor(req),
      }),
    });
  }),
);

vaultRouter.post(
  "/items/:itemId/employee-grants",
  validateParams(itemParamsSchema),
  validateBody(createEmployeeGrantSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createEmployeeGrantSchema>;
    const grant = await upsertEmployeeVaultGrant({
      companyId: companyId(req),
      itemId: req.params.itemId,
      actor: actor(req),
      employeeId: body.employeeId,
      accessLevel: body.accessLevel,
    });
    await auditEmployeeGrant(
      req,
      "upsert",
      grant.id,
      grant.employeeId,
      grant.accessLevel,
      grant.employee.name,
    );
    res.json({ grant });
  }),
);

vaultRouter.patch(
  "/items/:itemId/employee-grants/:grantId",
  validateParams(employeeGrantParamsSchema),
  validateBody(updateEmployeeGrantSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateEmployeeGrantSchema>;
    const grant = await updateEmployeeVaultGrant({
      companyId: companyId(req),
      itemId: req.params.itemId,
      grantId: req.params.grantId,
      actor: actor(req),
      accessLevel: body.accessLevel,
    });
    await auditEmployeeGrant(
      req,
      "update",
      grant.id,
      grant.employeeId,
      grant.accessLevel,
      grant.employee.name,
    );
    res.json({ grant });
  }),
);

vaultRouter.delete(
  "/items/:itemId/employee-grants/:grantId",
  validateParams(employeeGrantParamsSchema),
  asyncHandler(async (req, res) => {
    const deleted = await deleteEmployeeVaultGrant({
      companyId: companyId(req),
      itemId: req.params.itemId,
      grantId: req.params.grantId,
      actor: actor(req),
    });
    await auditEmployeeGrant(
      req,
      "delete",
      deleted.id,
      deleted.employeeId,
      deleted.accessLevel,
      deleted.employeeId,
    );
    res.json({ ok: true });
  }),
);

async function auditMemberAccess(
  req: VaultRequest,
  operation: "upsert" | "update" | "delete",
  accessId: string,
  userId: string,
  accessLevel: VaultMemberAccessLevel,
  label: string,
): Promise<void> {
  await recordAudit({
    companyId: companyId(req),
    actorUserId: req.userId,
    action: `vault.member_access.${operation}`,
    targetType: "vault_member_access",
    targetId: accessId,
    targetLabel: label,
    metadata: { vaultItemId: req.params.itemId, userId, accessLevel },
  });
}

async function auditEmployeeGrant(
  req: VaultRequest,
  operation: "upsert" | "update" | "delete",
  grantId: string,
  employeeId: string,
  accessLevel: EmployeeVaultAccessLevel,
  label: string,
): Promise<void> {
  await recordAudit({
    companyId: companyId(req),
    actorUserId: req.userId,
    action: `vault.employee_grant.${operation}`,
    targetType: "employee_vault_grant",
    targetId: grantId,
    targetLabel: label,
    metadata: { vaultItemId: req.params.itemId, employeeId, accessLevel },
  });
}
