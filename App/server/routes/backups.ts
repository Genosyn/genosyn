import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  backupFilePath,
  deleteBackup,
  deliverBackup,
  getBackupSchedule,
  ingestUploadedArchive,
  listBackups,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  restoreFromBackup,
  runBackup,
  serializeBackup,
  serializeSchedule,
  updateBackupSchedule,
} from "../services/backups.js";
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

backupsRouter.get("/", async (_req, res) => {
  const rows = await listBackups();
  res.json(rows.map(serializeBackup));
});

backupsRouter.post("/", async (_req, res, next) => {
  try {
    const row = await runBackup("manual");
    res.json(serializeBackup(row));
  } catch (err) {
    next(err);
  }
});

backupsRouter.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const ok = await deleteBackup(id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
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
 * Push an existing archive to every enabled off-box destination (NAS / remote
 * volume) on demand. Returns a per-destination result list so the UI can show
 * which mirrors succeeded and which errored.
 */
backupsRouter.post("/:id/deliver", async (req, res, next) => {
  try {
    const { id } = req.params;
    const results = await deliverBackup(id);
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

backupsRouter.post("/:id/restore", async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await restoreFromBackup(id);
    res.json({
      ok: true,
      safety: serializeBackup(result.safety),
      restored: serializeBackup(result.restored),
    });
  } catch (err) {
    next(err);
  }
});

backupsRouter.get("/:id/download", async (req, res) => {
  const { id } = req.params;
  const rows = await listBackups();
  const row = rows.find((r) => r.id === id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const abs = backupFilePath(row.filename);
  if (!fs.existsSync(abs)) {
    return res.status(404).json({ error: "Backup file is missing on disk" });
  }
  res.download(abs, row.filename);
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
});

/**
 * Saving retention enforces it immediately, so the response carries
 * `prunedNow` — how many archives that save deleted — for the UI to report.
 */
backupsRouter.put("/schedule", validateBody(scheduleSchema), async (req, res) => {
  const body = req.body as z.infer<typeof scheduleSchema>;
  const { schedule, pruned } = await updateBackupSchedule(body);
  res.json({ ...serializeSchedule(schedule), prunedNow: pruned });
});
