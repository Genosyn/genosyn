import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";
import { sendGlobalSmtpTest } from "../services/email.js";
import {
  clearGlobalSmtpOverride,
  describeGlobalSmtp,
  resolveGlobalSmtpDraft,
  updateGlobalSmtpOverride,
} from "../services/globalEmailTransport.js";

/**
 * Instance-wide admin endpoints. Not company-scoped — these describe the whole
 * deployment (database, migrations, disk, runtime) and its install-wide
 * settings (the global email transport). Any authenticated user may read them,
 * matching the install-wide backups router: they expose no per-company data and
 * self-hosted operators already control access via who can sign in.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/instance-health", async (_req, res, next) => {
  try {
    res.json(await getInstanceHealthReport());
  } catch (err) {
    next(err);
  }
});

// ───────────────────── global email transport ──────────────────────────────

adminRouter.get("/email-transport", async (_req, res, next) => {
  try {
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

const smtpFields = {
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255),
  // Blank means "keep the password currently in effect".
  pass: z.string().max(1024),
  from: z.string().max(255),
};

const saveSchema = z.object(smtpFields);

adminRouter.put(
  "/email-transport",
  validateBody(saveSchema),
  async (req, res, next) => {
    const body = req.body as z.infer<typeof saveSchema>;
    // The write is the only fallible-by-user step: a bad payload returns 400.
    try {
      await updateGlobalSmtpOverride(body);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error ? err.message : "Failed to save email transport",
      });
    }
    // The save already succeeded — a failure re-reading state to build the
    // response is a server error (500 via next), not a "save failed" 400.
    try {
      res.json(await describeGlobalSmtp());
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete("/email-transport", async (_req, res, next) => {
  try {
    await clearGlobalSmtpOverride();
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

const testSchema = z.object({ ...smtpFields, to: z.string().email() });

adminRouter.post(
  "/email-transport/test",
  validateBody(testSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof testSchema>;
    try {
      const settings = await resolveGlobalSmtpDraft(body);
      if (!settings.host) {
        return res.status(400).json({ ok: false, error: "SMTP host is required" });
      }
      const result = await sendGlobalSmtpTest({
        settings,
        to: body.to,
        triggeredByUserId: req.userId ?? null,
      });
      if (result.status === "sent") {
        res.json({ ok: true, logId: result.logId, messageId: result.messageId });
      } else {
        res
          .status(400)
          .json({ ok: false, error: result.errorMessage, logId: result.logId });
      }
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
