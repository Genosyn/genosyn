import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { decryptProviderConfig, sendTestEmail } from "../services/email.js";
import { PROVIDER_CATALOG } from "../services/emailTransports.js";
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  recordTestResult,
  serializeProvider,
  setDefault,
  updateProvider,
} from "../services/emailProviders.js";

/**
 * Per-company email-provider routes. Mounted under
 * `/api/companies/:cid/email/providers`.
 *
 *   GET    /catalog            — static catalog metadata used by the connect form
 *   GET    /                   — list company providers (credentials masked)
 *   POST   /                   — create a provider
 *   PATCH  /:pid               — rename / re-enable / re-key
 *   POST   /:pid/default       — promote this row to default
 *   DELETE /:pid               — drop the row (auto-promotes next if needed)
 *   POST   /:pid/test          — send a test email using a *saved* provider
 *   POST   /test               — send a test email using *inline* credentials
 *                                (used by the "Send test" button on the
 *                                add-provider form before the row exists)
 */
export const emailProvidersRouter = Router({ mergeParams: true });
emailProvidersRouter.use(requireAuth);
emailProvidersRouter.use(requireCompanyMember);

const KIND_VALUES = ["smtp", "sendgrid", "mailgun", "resend", "postmark"] as const;
const kindSchema = z.enum(KIND_VALUES);

emailProvidersRouter.get("/catalog", (_req, res) => {
  res.json(PROVIDER_CATALOG);
});

emailProvidersRouter.get("/", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const rows = await listProviders(cid);
  res.json(rows.map(serializeProvider));
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: kindSchema,
  fromAddress: z.string().min(3).max(254),
  replyTo: z.string().max(254).optional(),
  rawConfig: z.record(z.union([z.string(), z.number(), z.boolean()])),
  isDefault: z.boolean().optional(),
});

emailProvidersRouter.post("/", validateBody(createSchema), async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const body = req.body as z.infer<typeof createSchema>;
  try {
    const row = await createProvider({
      companyId: cid,
      name: body.name,
      kind: body.kind,
      fromAddress: body.fromAddress,
      replyTo: body.replyTo,
      rawConfig: body.rawConfig,
      isDefault: body.isDefault ?? false,
    });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "email_provider.create",
      targetType: "email_provider",
      targetId: row.id,
      targetLabel: `${row.kind} · ${row.name}`,
      metadata: { kind: row.kind, isDefault: row.isDefault },
    });
    res.json(serializeProvider(row));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to add email provider",
    });
  }
});

const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    fromAddress: z.string().min(3).max(254).optional(),
    replyTo: z.string().max(254).optional(),
    rawConfig: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    isDefault: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.fromAddress !== undefined ||
      v.replyTo !== undefined ||
      v.rawConfig !== undefined ||
      v.isDefault !== undefined ||
      v.enabled !== undefined,
    { message: "Nothing to update" },
  );

emailProvidersRouter.patch(
  "/:pid",
  validateBody(patchSchema),
  async (req, res) => {
    const { cid, pid } = req.params as Record<string, string>;
    const row = await getProvider(cid, pid);
    if (!row) return res.status(404).json({ error: "Provider not found" });
    try {
      const updated = await updateProvider(row, req.body as z.infer<typeof patchSchema>);
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "email_provider.update",
        targetType: "email_provider",
        targetId: updated.id,
        targetLabel: `${updated.kind} · ${updated.name}`,
      });
      res.json(serializeProvider(updated));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to update provider",
      });
    }
  },
);

emailProvidersRouter.post("/:pid/default", async (req, res) => {
  const { cid, pid } = req.params as Record<string, string>;
  const row = await getProvider(cid, pid);
  if (!row) return res.status(404).json({ error: "Provider not found" });
  await setDefault(cid, pid);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "email_provider.set_default",
    targetType: "email_provider",
    targetId: row.id,
    targetLabel: `${row.kind} · ${row.name}`,
  });
  const refreshed = await getProvider(cid, pid);
  res.json(refreshed ? serializeProvider(refreshed) : { ok: true });
});

emailProvidersRouter.delete("/:pid", async (req, res) => {
  const { cid, pid } = req.params as Record<string, string>;
  const row = await getProvider(cid, pid);
  if (!row) return res.status(404).json({ error: "Provider not found" });
  await deleteProvider(cid, pid);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "email_provider.delete",
    targetType: "email_provider",
    targetId: row.id,
    targetLabel: `${row.kind} · ${row.name}`,
  });
  res.json({ ok: true });
});

const testSavedSchema = z.object({
  to: z.string().email(),
});

emailProvidersRouter.post(
  "/:pid/test",
  validateBody(testSavedSchema),
  async (req, res) => {
    const { cid, pid } = req.params as Record<string, string>;
    const row = await getProvider(cid, pid);
    if (!row) return res.status(404).json({ error: "Provider not found" });
    const { to } = req.body as z.infer<typeof testSavedSchema>;

    const cfg = decryptProviderConfig(row);
    const result = await sendTestEmail({
      companyId: cid,
      kind: row.kind,
      fromAddress: row.fromAddress,
      replyTo: row.replyTo,
      rawConfig: cfg.config as Record<string, unknown>,
      to,
      triggeredByUserId: req.userId ?? null,
    });
    await recordTestResult(
      row,
      result.status === "sent" ? "ok" : "failed",
      result.errorMessage,
    );
    if (result.status === "sent") {
      res.json({
        ok: true,
        logId: result.logId,
        messageId: result.messageId,
      });
    } else {
      res.status(400).json({
        ok: false,
        error: result.errorMessage,
        logId: result.logId,
      });
    }
  },
);

const testInlineSchema = z.object({
  kind: kindSchema,
  fromAddress: z.string().min(3).max(254),
  replyTo: z.string().max(254).optional(),
  rawConfig: z.record(z.union([z.string(), z.number(), z.boolean()])),
  to: z.string().email(),
});

emailProvidersRouter.post(
  "/test",
  validateBody(testInlineSchema),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof testInlineSchema>;
    try {
      const result = await sendTestEmail({
        companyId: cid,
        kind: body.kind,
        fromAddress: body.fromAddress,
        replyTo: body.replyTo,
        rawConfig: body.rawConfig,
        to: body.to,
        triggeredByUserId: req.userId ?? null,
      });
      if (result.status === "sent") {
        res.json({
          ok: true,
          logId: result.logId,
          messageId: result.messageId,
        });
      } else {
        res.status(400).json({
          ok: false,
          error: result.errorMessage,
          logId: result.logId,
        });
      }
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
