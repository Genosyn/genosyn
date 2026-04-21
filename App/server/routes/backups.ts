import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  backupFilePath,
  deleteBackup,
  getBackupSchedule,
  listBackups,
  runBackup,
  serializeBackup,
  serializeSchedule,
  updateBackupSchedule,
} from "../services/backups.js";

/**
 * Install-wide backup endpoints. Not company-scoped — a backup covers every
 * company's data. Any authenticated user can trigger and download backups;
 * gating by membership doesn't help because the archive includes everyone's
 * rows anyway. Self-hosted operators control access via who can sign in.
 */
export const backupsRouter = Router();
backupsRouter.use(requireAuth);

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
});

backupsRouter.put(
  "/schedule",
  validateBody(scheduleSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof scheduleSchema>;
    const updated = await updateBackupSchedule(body);
    res.json(serializeSchedule(updated));
  },
);
