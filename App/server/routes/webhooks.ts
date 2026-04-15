import { Router } from "express";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "../services/runner.js";

/**
 * Unauthenticated trigger surface. The URL itself is the credential — each
 * routine has a random token in its path. We intentionally do NOT gate with
 * session auth here; that's the whole point of a webhook.
 *
 * Body is captured into the journal for observability but is NOT injected
 * into the CLI prompt in v1. Templating webhook payloads into prompts is a
 * separate feature that deserves its own design (security, schema, etc.).
 */
export const webhooksRouter = Router();

webhooksRouter.post("/r/:routineId/:token", async (req, res) => {
  const { routineId, token } = req.params;
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: routineId,
  });
  // Constant-ish comparison: we do a length + equality check. Token is
  // 48 hex chars so timing leakage of the equality op is not meaningful
  // against a secret of this size, but we still avoid leaking existence.
  if (
    !routine ||
    !routine.webhookEnabled ||
    !routine.webhookToken ||
    routine.webhookToken !== token
  ) {
    return res.status(404).json({ error: "Not found" });
  }
  if (!routine.enabled) {
    return res.status(409).json({ error: "Routine is disabled" });
  }
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
  });
  if (!emp) return res.status(410).json({ error: "Employee gone" });

  // Record the payload (truncated) so you can audit what was posted.
  const payloadPreview = JSON.stringify(req.body ?? {}).slice(0, 1000);
  await AppDataSource.getRepository(JournalEntry).save(
    AppDataSource.getRepository(JournalEntry).create({
      employeeId: emp.id,
      kind: "system",
      title: `Webhook triggered routine "${routine.name}"`,
      body: payloadPreview ? `payload: ${payloadPreview}` : "",
      routineId: routine.id,
      runId: null,
      authorUserId: null,
    }),
  );

  if (routine.requiresApproval) {
    const approvalRepo = AppDataSource.getRepository(Approval);
    const pending = approvalRepo.create({
      companyId: emp.companyId,
      routineId: routine.id,
      employeeId: emp.id,
      status: "pending",
    });
    const saved = await approvalRepo.save(pending);
    return res.json({ status: "pending_approval", approvalId: saved.id });
  }

  // Fire and forget. The Run row is persisted by the runner regardless.
  runRoutine(routine).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[webhook] routine ${routine.id} failed:`, err);
  });
  res.json({ status: "accepted" });
});
