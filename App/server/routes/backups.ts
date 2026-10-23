import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  backupFilePath,
  backupHistoryItem,
  deleteBackup,
  getBackup,
  getBackupSchedule,
  ingestUploadedArchive,
  listBackupHistory,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  restoreFromBackup,
  serializeBackup,
  serializeSchedule,
  startBackup,
  startCopy,
  updateBackupSchedule,
} from "../services/backups.js";
import { serializeCopy } from "../services/backupCopies.js";
import { getLastBackupVerification, verifyBackups } from "../services/backupVerification.js";
import { config } from "../../config.js";

/**
 * Install-wide backup endpoints. Not company-scoped — a backup covers every
 * company's data, and restore replaces the entire data directory. Gated to
 * master admins (the instance operator surface), same bar as the Admin router;
 * company membership is irrelevant since the archive spans everyone's rows.
 */
export const backupsRouter = Router();
backupsRouter.use(requireAuth);
backupsRouter.use(requireMasterAdmin);
backupsRouter.use((_req, res, next) => {
  if (config.security.multiTenant) {
    return res.status(409).json({
      error:
        "Built-in archives are unavailable in shared SaaS mode. Back up Postgres and the shared data volume using your platform.",
    });
  }
  next();
});

const idParams = z.object({ id: z.string().min(1).max(64) });

/** History: every backup with where it is — on this server, and each off-box copy. */
backupsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await listBackupHistory());
  } catch (err) {
    next(err);
  }
});

/** The last daily backup verification, or null before the first one has run. */
backupsRouter.get("/verification", async (_req, res) => {
  res.json({ verification: await getLastBackupVerification() });
});

/** Verify the backups now — the same verification the daily task runs, emails included. */
backupsRouter.post("/verification", async (_req, res, next) => {
  try {
    res.json({ verification: await verifyBackups() });
  } catch (err) {
    next(err);
  }
});

/**
 * Back up now. Answers as soon as the backup is recorded, with its History row
 * (`inProgress` while this server writes it): the archive and its off-box
 * copies can take hours, and the page follows them from History. While a
 * backup is already running, that one comes back with `alreadyRunning`.
 */
backupsRouter.post("/", async (_req, res, next) => {
  try {
    const { backup, alreadyRunning } = await startBackup("manual");
    res.status(202).json({ ...(await backupHistoryItem(backup)), alreadyRunning });
  } catch (err) {
    next(err);
  }
});

backupsRouter.delete("/:id", validateParams(idParams), async (req, res, next) => {
  try {
    const ok = await deleteBackup(req.params.id);
    if (!ok) return res.status(404).json({ error: "This backup no longer exists." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Streamed archive upload. Body is the zip bytes with Content-Type:
 * application/zip so express.json() skips it and `req` stays a readable
 * stream. On success we register the file as a Backup row with
 * `kind: 'uploaded'` so it shows up in History alongside manual/scheduled
 * runs and is eligible for restore.
 */
backupsRouter.post("/upload", async (req, res, next) => {
  try {
    const row = await ingestUploadedArchive(req);
    res.json(serializeBackup(row));
  } catch (err) {
    next(err);
  }
});

/**
 * Copy an existing backup off-box now: to every enabled destination, or to the
 * one `destinationId` names (Try again on one copy). Answers once the copies
 * are queued — each `pending`, or as they stand with `alreadyRunning` when
 * this backup is already being copied; History follows them from there.
 */
const copySchema = z
  .object({
    destinationId: z.string().min(1).max(64).optional(),
  })
  .strict();

backupsRouter.post(
  "/:id/deliver",
  validateParams(idParams),
  validateBody(copySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof copySchema>;
      const { copies, alreadyRunning } = await startCopy(req.params.id, body.destinationId ?? null);
      res.status(202).json({ ok: true, alreadyRunning, copies: copies.map(serializeCopy) });
    } catch (err) {
      next(err);
    }
  },
);

backupsRouter.post("/:id/restore", validateParams(idParams), async (req, res, next) => {
  try {
    const result = await restoreFromBackup(req.params.id);
    res.json({
      ok: true,
      safety: serializeBackup(result.safety),
      restored: serializeBackup(result.restored),
    });
  } catch (err) {
    next(err);
  }
});

backupsRouter.get("/:id/download", validateParams(idParams), async (req, res, next) => {
  try {
    const row = await getBackup(req.params.id);
    if (!row) return res.status(404).json({ error: "This backup no longer exists." });
    const abs = backupFilePath(row.filename);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: "This backup is no longer on this server." });
    }
    res.download(abs, row.filename);
  } catch (err) {
    next(err);
  }
});

backupsRouter.get("/schedule", async (_req, res) => {
  const sched = await getBackupSchedule();
  res.json(serializeSchedule(sched));
});

const scheduleSchema = z.object({
  enabled: z.boolean().optional(),
  frequency: z.enum(["daily", "weekly", "monthly"]).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  retentionEnabled: z.boolean().optional(),
  retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
  offBoxRetentionEnabled: z.boolean().optional(),
  offBoxRetentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
});

/**
 * Saving on-box retention enforces it immediately, so the response carries
 * `prunedNow` — how many archives that save deleted — for the UI to report.
 * The off-box policy applies at each destination's next delivery.
 */
backupsRouter.put("/schedule", validateBody(scheduleSchema), async (req, res) => {
  const body = req.body as z.infer<typeof scheduleSchema>;
  const { schedule, pruned } = await updateBackupSchedule(body);
  res.json({ ...serializeSchedule(schedule), prunedNow: pruned });
});
