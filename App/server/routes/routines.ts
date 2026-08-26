import { Router } from "express";
import { z } from "zod";
import cron from "node-cron";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { Run } from "../db/entities/Run.js";
import { Approval } from "../db/entities/Approval.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import crypto from "node:crypto";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
  onRoutePaths,
  roleAtLeast,
} from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { routineTemplate } from "../services/files.js";
import { nextRunFor, registerRoutine } from "../services/cron.js";
import { startRoutineRun, getLiveRunSnapshot, RUN_LOG_MAX_BYTES } from "../services/runner.js";
import { cancelPendingRetry } from "../services/runRecovery.js";
import { recordAudit } from "../services/audit.js";
import { getOwnedMemberBrowser } from "../services/memberBrowsers.js";
import { memberManagesEmployee } from "../services/reportingLine.js";
import { revokeDisabledBrowserSessionsForEmployee } from "../services/browserAccess.js";
import {
  deleteBrowserRecordingsForRunIds,
  getBrowserRecordingFile,
  listBrowserRecordingsForRun,
  markBrowserRecordingRoutineDeleting,
  type BrowserRecordingInfo,
} from "../services/browserRecordings.js";
import {
  deleteTagAssignments,
  replaceResourceTags,
  tagsByResourceIds,
  tagsForResource,
  validateCompanyTagIds,
} from "../services/tags.js";
import { resolveFolderForCompany, RoutineFolderError } from "../services/routineFolders.js";
import { emitResourceChange } from "../services/resourceEvents.js";

export const routinesRouter = Router({ mergeParams: true });
routinesRouter.use(requireAuth);
routinesRouter.use(requireCompanyMember);
routinesRouter.use(
  onRoutePaths(
    ["/routines", "/runs", /^\/employees\/[^/]+\/routines(?:\/|$)/],
    requireCompanyRoleForMutations("admin"),
  ),
);

async function loadEmp(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: eid, companyId: cid });
}
async function loadCo(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueSlug(employeeId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Routine);
  let slug = base || "routine";
  let n = 1;
  while (await repo.findOneBy({ employeeId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function employeeOwnsModel(employeeId: string, modelId: string): Promise<boolean> {
  return AppDataSource.getRepository(AIModel).existsBy({ id: modelId, employeeId });
}

async function findRoutineByName(
  employeeId: string,
  name: string,
  excludeId?: string,
): Promise<Routine | null> {
  const qb = AppDataSource.getRepository(Routine)
    .createQueryBuilder("r")
    .where("r.employeeId = :employeeId", { employeeId })
    .andWhere("LOWER(r.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("r.id != :excludeId", { excludeId });
  return qb.getOne();
}

/**
 * The employee fields the Routines section needs to answer "who is this
 * assigned to?" — enough for an avatar, a name, and a link to the employee.
 * Deliberately narrow: the full row carries the Soul body and browser
 * allowlist, neither of which a routine list has any business shipping.
 */
type EmployeeSummary = Pick<AIEmployee, "id" | "name" | "slug" | "role" | "avatarKey">;

function employeeSummary(emp: AIEmployee): EmployeeSummary {
  return { id: emp.id, name: emp.name, slug: emp.slug, role: emp.role, avatarKey: emp.avatarKey };
}

/**
 * Newest Run per routine, in one query. `Routine.lastRunAt` already records
 * *when* a routine last fired, but not how it went — the Routines list wants
 * the outcome so a failing routine is visible without opening it.
 *
 * The correlated MAX subquery is portable across the sqlite and postgres
 * drivers (a window function or DISTINCT ON would not be) and rides the
 * `["routineId", "startedAt"]` index that Run already declares for exactly
 * this access pattern. Two runs of one routine sharing a startedAt timestamp
 * would both come back; the Map below keeps the first and drops the tie.
 */
async function lastRunByRoutine(routineIds: string[]): Promise<Map<string, Run>> {
  if (routineIds.length === 0) return new Map();
  const runs = await AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .select([
      "run.id",
      "run.routineId",
      "run.status",
      "run.startedAt",
      "run.finishedAt",
      "run.exitCode",
      "run.attempt",
      "run.retryAt",
      "run.missedSlots",
      "run.outcomeVerdict",
    ])
    .where("run.routineId IN (:...routineIds)", { routineIds })
    .andWhere(
      "run.startedAt = (SELECT MAX(r2.startedAt) FROM runs r2 WHERE r2.routineId = run.routineId)",
    )
    .getMany();
  const byRoutine = new Map<string, Run>();
  for (const run of runs) if (!byRoutine.has(run.routineId)) byRoutine.set(run.routineId, run);
  return byRoutine;
}

/**
 * Every routine in the company, with its employee and last run attached.
 *
 * Routines used to be reachable only through the employee that owns them, so
 * "what is scheduled around here?" meant opening each employee in turn. This
 * backs the top-level Routines section. `body` is omitted — the list renders
 * names and schedules, and the briefs are fetched per routine via
 * `/routines/:rid/readme`.
 */
routinesRouter.get("/routines", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const employees = await AppDataSource.getRepository(AIEmployee).findBy({ companyId: cid });
  if (employees.length === 0) return res.json([]);
  const byId = new Map(employees.map((e) => [e.id, e]));

  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: In([...byId.keys()]) },
  });
  const lastRuns = await lastRunByRoutine(routines.map((r) => r.id));
  const tags = await tagsByResourceIds(
    cid,
    "routine",
    routines.map((r) => r.id),
  );

  // Group by employee, then by name, so the list reads like a roster rather
  // than insertion order.
  const rows = routines.map(({ body: _body, ...routine }) => {
    const emp = byId.get(routine.employeeId);
    return {
      ...routine,
      employee: emp ? employeeSummary(emp) : null,
      lastRun: lastRuns.get(routine.id) ?? null,
      tags: tags.get(routine.id) ?? [],
    };
  });
  rows.sort(
    (a, b) =>
      (a.employee?.name ?? "").localeCompare(b.employee?.name ?? "") ||
      a.name.localeCompare(b.name),
  );
  res.json(rows);
});

routinesRouter.get("/employees/:eid/routines", async (req, res) => {
  const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: emp.id },
  });
  const tags = await tagsByResourceIds(
    (req.params as Record<string, string>).cid,
    "routine",
    routines.map((r) => r.id),
  );
  res.json(routines.map((routine) => ({ ...routine, tags: tags.get(routine.id) ?? [] })));
});

// node-cron validates and cron-parser schedules, and the two do not agree —
// node-cron accepts expressions like "5-1 9 * * *" that cron-parser throws on,
// which used to produce a routine that saved with a 200 and then never fired.
// Both checks, so what we accept is exactly what we can schedule.
const cronExprSchema = z
  .string()
  .refine((v) => cron.validate(v), "Invalid cron expression")
  .refine((v) => nextRunFor(v) !== null, "That cron expression cannot be scheduled");

const createSchema = z.object({
  name: z.string().min(1).max(80),
  cronExpr: cronExprSchema,
  tagIds: z.array(z.string().uuid()).max(20).optional(),
  // Which folder to file the new routine in. Omitted or null leaves it
  // unfiled, which is where every routine created before folders shipped sits.
  folderId: z.string().uuid().nullable().optional(),
});

routinesRouter.post("/employees/:eid/routines", validateBody(createSchema), async (req, res) => {
  const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const co = await loadCo((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const body = req.body as z.infer<typeof createSchema>;
  if (await findRoutineByName(emp.id, body.name)) {
    return res
      .status(409)
      .json({ error: "A routine with that name already exists for this employee" });
  }
  try {
    await validateCompanyTagIds(co.id, body.tagIds ?? []);
    await resolveFolderForCompany(co.id, body.folderId ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: message });
  }
  const slug = await uniqueSlug(emp.id, toSlug(body.name));
  const repo = AppDataSource.getRepository(Routine);
  const r = repo.create({
    employeeId: emp.id,
    name: body.name,
    slug,
    cronExpr: body.cronExpr,
    enabled: true,
    lastRunAt: null,
    folderId: body.folderId ?? null,
    body: routineTemplate(body.name, body.cronExpr),
  });
  registerRoutine(r);
  await repo.save(r);
  const tags = await replaceResourceTags(co.id, "routine", r.id, body.tagIds ?? []);
  await recordAudit({
    companyId: co.id,
    actorUserId: req.userId ?? null,
    action: "routine.create",
    targetType: "routine",
    targetId: r.id,
    targetLabel: r.name,
    metadata: { employeeId: emp.id, cronExpr: r.cronExpr },
  });
  res.json({ ...r, tags });
});

async function loadRoutine(cid: string, rid: string) {
  const r = await AppDataSource.getRepository(Routine).findOneBy({ id: rid });
  if (!r) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: r.employeeId,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await loadCo(cid);
  if (!co) return null;
  return { routine: r, emp, co };
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  cronExpr: cronExprSchema.optional(),
  enabled: z.boolean().optional(),
  timeoutSec: z
    .number()
    .int()
    .min(10)
    .max(6 * 60 * 60)
    .optional(),
  requiresApproval: z.boolean().optional(),
  // Null inherits the employee's active model; a string pins one of the
  // employee's own models to this routine. Ownership is checked below.
  modelId: z.string().uuid().nullable().optional(),
  // Three-valued: null inherits the employee's `browserEnabled`; explicit
  // boolean overrides for this routine only.
  browserEnabledOverride: z.boolean().nullable().optional(),
  memberBrowserId: z.string().uuid().nullable().optional(),
  // Reliability. Defaults catch up once after downtime and disable ordinary
  // failure/timeout retries. A future initial scheduled Run on an enabled,
  // ungated routine marked interrupted is the safety exception: one durable
  // recovery attempt is due an hour later. Higher configured limits bound
  // interruptions later in the retry chain.
  catchUpPolicy: z.enum(["once", "skip"]).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  retryBackoffSec: z
    .number()
    .int()
    .min(10)
    .max(6 * 60 * 60)
    .optional(),
  retryOnTimeout: z.boolean().optional(),
  // The Routine's definition of done. Empty string clears it, which also
  // switches the post-Run outcome check off for future Runs.
  acceptanceCriteria: z.string().max(4_000).optional(),
  // Tags aren't a Routine column — they're assignments in the shared catalog,
  // so the create route already accepts these. Editing them here keeps the
  // routine's own endpoint symmetric instead of forcing a second call to the
  // generic PUT /tags/resources/routine/:rid. Passing the array replaces the
  // whole set; omitting it leaves existing assignments untouched.
  tagIds: z.array(z.string().uuid()).max(20).optional(),
  // Re-file this routine. Null unfiles it; a uuid must name a folder in the
  // same company as the owning employee. See `POST /routines/move` for the
  // bulk version the Routines list uses.
  folderId: z.string().uuid().nullable().optional(),
});

routinesRouter.patch("/routines/:rid", validateBody(patchSchema), async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof patchSchema>;
  const r = found.routine;
  // Validate tag ownership before mutating the routine so a bad tag id fails
  // the whole request rather than leaving a half-applied edit.
  if (body.tagIds !== undefined) {
    try {
      await validateCompanyTagIds(found.co.id, body.tagIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: message });
    }
  }
  if (body.folderId !== undefined) {
    try {
      await resolveFolderForCompany(found.co.id, body.folderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: message });
    }
    r.folderId = body.folderId;
  }
  if (body.name !== undefined) {
    if (await findRoutineByName(r.employeeId, body.name, r.id)) {
      return res
        .status(409)
        .json({ error: "A routine with that name already exists for this employee" });
    }
    r.name = body.name;
  }
  if (body.cronExpr !== undefined) r.cronExpr = body.cronExpr;
  if (body.enabled !== undefined) r.enabled = body.enabled;
  if (body.timeoutSec !== undefined) r.timeoutSec = body.timeoutSec;
  if (body.requiresApproval !== undefined) r.requiresApproval = body.requiresApproval;
  if (body.modelId !== undefined) {
    // A routine may only pin a model its own employee owns — otherwise one
    // employee's routine could borrow another's credentials.
    if (body.modelId !== null && !(await employeeOwnsModel(r.employeeId, body.modelId))) {
      return res.status(400).json({ error: "That model does not belong to this employee" });
    }
    r.modelId = body.modelId;
  }
  if (body.browserEnabledOverride !== undefined) {
    r.browserEnabledOverride = body.browserEnabledOverride;
  }
  if (body.memberBrowserId !== undefined) {
    // The requester must own the browser and have opted it into unattended
    // use. Checked here rather than only at spawn time so the person editing
    // the routine finds out now, not at 3am when the run fails.
    if (body.memberBrowserId !== null) {
      const browser = await getOwnedMemberBrowser(found.co.id, req.userId!, body.memberBrowserId);
      if (!browser) {
        return res.status(404).json({ error: "That browser is not one of yours" });
      }
      if (!browser.allowUnattended || !browser.routineRecordingConsentAt) {
        return res.status(400).json({
          error: `"${browser.name}" is not available to scheduled Routines. Turn on unattended use for it first.`,
        });
      }
    }
    r.memberBrowserId = body.memberBrowserId;
  }
  if (body.catchUpPolicy !== undefined) r.catchUpPolicy = body.catchUpPolicy;
  if (body.maxAttempts !== undefined) r.maxAttempts = body.maxAttempts;
  if (body.retryBackoffSec !== undefined) r.retryBackoffSec = body.retryBackoffSec;
  if (body.retryOnTimeout !== undefined) r.retryOnTimeout = body.retryOnTimeout;
  if (body.acceptanceCriteria !== undefined) r.acceptanceCriteria = body.acceptanceCriteria;
  // Only re-derive the pending fire time when the schedule itself changed —
  // renaming a routine or nudging its timeout shouldn't throw away the slot it
  // was already waiting on.
  if (body.cronExpr !== undefined || body.enabled !== undefined) registerRoutine(r);
  await AppDataSource.getRepository(Routine).save(r);
  if (body.browserEnabledOverride !== undefined) {
    await revokeDisabledBrowserSessionsForEmployee(r.employeeId);
  }
  const tags =
    body.tagIds !== undefined
      ? await replaceResourceTags(found.co.id, "routine", r.id, body.tagIds)
      : await tagsForResource(found.co.id, "routine", r.id);
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: "routine.update",
    targetType: "routine",
    targetId: r.id,
    targetLabel: r.name,
    metadata: { changes: body },
  });
  res.json({ ...r, tags });
});

/**
 * Move a batch of routines into one folder (or out of all of them, with a null
 * `folderId`). The bulk form exists because filing an existing library is the
 * whole reason folders are here: doing it one PATCH at a time across eighty
 * routines is the tedium that stops people organizing at all.
 *
 * Every id is checked against the company before anything is written, so a
 * single foreign routine fails the request instead of half-applying it.
 */
const moveSchema = z.object({
  routineIds: z.array(z.string().uuid()).min(1).max(200),
  folderId: z.string().uuid().nullable(),
});

routinesRouter.post("/routines/move", validateBody(moveSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof moveSchema>;
  const co = await loadCo(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  try {
    await resolveFolderForCompany(co.id, body.folderId);
  } catch (err) {
    if (!(err instanceof RoutineFolderError)) throw err;
    return res.status(400).json({ error: err.message });
  }

  const employeeIds = (
    await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
      select: { id: true },
    })
  ).map((e) => e.id);
  const routineIds = [...new Set(body.routineIds)];
  const routines = employeeIds.length
    ? await AppDataSource.getRepository(Routine).find({
        where: { id: In(routineIds), employeeId: In(employeeIds) },
      })
    : [];
  if (routines.length !== routineIds.length) {
    return res.status(404).json({ error: "One or more routines are not in this company" });
  }

  // A targeted column update, then an explicit live-sync frame.
  //
  // Neither half is optional. `save()` on the loaded entities would write back
  // every column that differs from the row as it stands at save time, so a
  // `nextRunAt` the cron heartbeat advanced between the read and the write
  // would be silently reverted — a routine re-firing or skipping a slot
  // because somebody filed it. `update()` touches only `folderId`, but it
  // broadcasts just the partial it was handed, which carries no `employeeId`
  // for the subscriber to hop to the company on, so on its own it tells no
  // other browser anything. See ROADMAP M31.
  await AppDataSource.getRepository(Routine).update(
    { id: In(routineIds) },
    { folderId: body.folderId },
  );
  emitResourceChange(co.id, "routine");
  await recordAudit({
    companyId: co.id,
    actorUserId: req.userId ?? null,
    action: "routine.move",
    targetType: "routine_folder",
    targetId: body.folderId,
    targetLabel: `${routines.length} routine${routines.length === 1 ? "" : "s"}`,
    metadata: { routineIds, folderId: body.folderId },
  });
  res.json({ ok: true, moved: routines.length, folderId: body.folderId });
});

routinesRouter.delete("/routines/:rid", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  markBrowserRecordingRoutineDeleting(found.routine.id);
  const runs = await AppDataSource.getRepository(Run).find({
    where: { routineId: found.routine.id },
    select: { id: true },
  });
  await AppDataSource.getRepository(Approval).delete({ routineId: found.routine.id });
  // The routine's Ask AI conversation goes with it — it is about this routine
  // and nothing else, so leaving it behind leaves rows nobody can ever reach.
  await AppDataSource.getRepository(RoutineChatMessage).delete({ routineId: found.routine.id });
  await deleteBrowserRecordingsForRunIds(runs.map((run) => run.id));
  await AppDataSource.getRepository(Run).delete({ routineId: found.routine.id });
  await deleteTagAssignments("routine", found.routine.id);
  await AppDataSource.getRepository(Routine).delete({ id: found.routine.id });
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: "routine.delete",
    targetType: "routine",
    targetId: found.routine.id,
    targetLabel: found.routine.name,
    metadata: { employeeId: found.emp.id },
  });
  res.json({ ok: true });
});

/**
 * One routine, with its employee attached. The Routines detail page resolves a
 * routine from `/routines/:empSlug/:routineSlug`, so it needs the employee to
 * render "assigned to" and to load that employee's models for the pin picker.
 * `body` rides along here (unlike the list) — the detail page shows the brief.
 */
routinesRouter.get("/routines/:rid", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const lastRuns = await lastRunByRoutine([found.routine.id]);
  const tags = await tagsForResource(found.co.id, "routine", found.routine.id);
  res.json({
    ...found.routine,
    employee: employeeSummary(found.emp),
    lastRun: lastRuns.get(found.routine.id) ?? null,
    tags,
  });
});

routinesRouter.get("/routines/:rid/readme", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({ content: found.routine.body });
});

const readmeSchema = z.object({ content: z.string() });

routinesRouter.put("/routines/:rid/readme", validateBody(readmeSchema), async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  found.routine.body = (req.body as z.infer<typeof readmeSchema>).content;
  await AppDataSource.getRepository(Routine).save(found.routine);
  res.json({ ok: true });
});

/**
 * Turn webhook on (generates a fresh 48-hex token) or off (clears the token).
 * Regenerating a token is accomplished by calling this twice: once with
 * `enabled=false`, then again with `enabled=true`.
 */
const webhookSchema = z.object({ enabled: z.boolean() });
routinesRouter.post("/routines/:rid/webhook", validateBody(webhookSchema), async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof webhookSchema>;
  const r = found.routine;
  r.webhookEnabled = body.enabled;
  r.webhookToken = body.enabled ? crypto.randomBytes(24).toString("hex") : null;
  await AppDataSource.getRepository(Routine).save(r);
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: body.enabled ? "routine.webhook.enable" : "routine.webhook.disable",
    targetType: "routine",
    targetId: r.id,
    targetLabel: r.name,
  });
  res.json(r);
});

routinesRouter.post("/routines/:rid/run", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  await recordAudit({
    companyId: found.co.id,
    actorUserId: req.userId ?? null,
    action: "routine.run.manual",
    targetType: "routine",
    targetId: found.routine.id,
    targetLabel: found.routine.name,
  });
  // Return as soon as the Run row exists so the UI can open a tail-log modal
  // and poll /runs/:runId/log while the child process is still alive. The
  // completion promise is left to settle in the background; errors are
  // captured on the Run row, so we just swallow rejections here.
  const { run, completion } = await startRoutineRun(found.routine);
  completion.catch((err) => {
    console.error("[run]", err);
  });
  res.json(run);
});

/**
 * List recent runs for a routine, newest-first. Returns lightweight metadata
 * (sans the captured `logContent`) so the history timeline renders fast;
 * log text is fetched lazily via /runs/:runId/log.
 */
routinesRouter.get("/routines/:rid/runs", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const runs = await AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .select([
      "run.id",
      "run.routineId",
      "run.startedAt",
      "run.finishedAt",
      "run.status",
      "run.exitCode",
      "run.createdAt",
      "run.triggerKind",
      "run.attempt",
      "run.retryAt",
      "run.missedSlots",
      "run.outcomeVerdict",
      "run.outcomeNote",
      "run.tokensIn",
      "run.tokensOut",
    ])
    .where("run.routineId = :rid", { rid: found.routine.id })
    .orderBy("run.startedAt", "DESC")
    .take(50)
    .getMany();
  res.json(runs);
});

const runRecordingParamsSchema = z
  .object({
    cid: z.string().uuid(),
    runId: z.string().uuid(),
  })
  .strict();
const recordingFileParamsSchema = runRecordingParamsSchema
  .extend({ sessionId: z.string().uuid() })
  .strict();
const recordingFileQuerySchema = z
  .object({ disposition: z.enum(["inline", "attachment"]).default("inline") })
  .strict();

async function loadCompanyRun(companyId: string, runId: string): Promise<Run | null> {
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: runId });
  if (!run) return null;
  return (await loadRoutine(companyId, run.routineId)) ? run : null;
}

/**
 * Who may watch one browser recording.
 *
 * A **Member browser** is a human's own computer, so its recording stays with
 * that exact owner no matter where they sit on the org chart. Genosyn's own
 * Browser is company equipment: company admins can watch it, and so can the
 * Member the AI Employee reports to — supervising an employee's work is the
 * whole point of the reporting line, and it should not require handing that
 * Member the admin role over everything else.
 */
async function canReadBrowserRecording(
  req: Parameters<typeof requireBrowserSession>[0],
  session: BrowserSession,
): Promise<boolean> {
  if (session.memberBrowserId) {
    if (!req.userId) return false;
    return AppDataSource.getRepository(MemberBrowser).existsBy({
      id: session.memberBrowserId,
      companyId: session.companyId,
      ownerUserId: req.userId,
    });
  }
  if (req.companyRole && roleAtLeast("admin", req.companyRole)) return true;
  if (!req.userId) return false;
  return memberManagesEmployee(session.companyId, session.employeeId, req.userId);
}

async function recordingsVisibleToRequester(
  req: Parameters<typeof requireBrowserSession>[0],
  run: Run,
): Promise<BrowserRecordingInfo[]> {
  if (req.apiKey) return [];
  const [recordings, sessions] = await Promise.all([
    listBrowserRecordingsForRun(run.id),
    AppDataSource.getRepository(BrowserSession).findBy({ runId: run.id }),
  ]);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const visible: BrowserRecordingInfo[] = [];
  for (const recording of recordings) {
    const session = byId.get(recording.id);
    if (session?.companyId === req.params.cid && (await canReadBrowserRecording(req, session))) {
      visible.push(recording);
    }
  }
  return visible;
}

/** Metadata-only collection; video bytes are served from the item route below. */
routinesRouter.get(
  "/runs/:runId/browser-recordings",
  requireBrowserSession,
  validateParams(runRecordingParamsSchema),
  async (req, res) => {
    const run = await loadCompanyRun(req.params.cid, req.params.runId);
    if (!run) return res.status(404).json({ error: "Not found" });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await recordingsVisibleToRequester(req, run));
  },
);

/**
 * Seekable inline stream or download. Express sendFile implements byte-range
 * requests, which lets the video element seek without loading the whole MP4.
 */
routinesRouter.get(
  "/runs/:runId/browser-recordings/:sessionId",
  requireBrowserSession,
  validateParams(recordingFileParamsSchema),
  async (req, res, next) => {
    const query = recordingFileQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: "ValidationError", issues: query.error.issues });
    }
    const run = await loadCompanyRun(req.params.cid, req.params.runId);
    if (!run) return res.status(404).json({ error: "Not found" });
    const session = await AppDataSource.getRepository(BrowserSession).findOneBy({
      id: req.params.sessionId,
      runId: run.id,
      companyId: req.params.cid,
    });
    if (!session || !(await canReadBrowserRecording(req, session))) {
      return res.status(404).json({ error: "Not found" });
    }
    const recording = await getBrowserRecordingFile(session);
    if (!recording) return res.status(404).json({ error: "Not found" });
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", recording.info.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Disposition",
      `${query.data.disposition}; filename="${recording.info.filename}"`,
    );
    return res.sendFile(recording.path, (error) => {
      if (!error) return;
      if (!res.headersSent) {
        // sendFile preserves headers set before it discovers an unsatisfiable
        // Range. Clear the media-only values before the API error middleware
        // writes its JSON response; keep Content-Range so clients learn the
        // current file size and can recover their seek request.
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Type");
        res.removeHeader("Content-Length");
        if (typeof error === "object" && "status" in error && error.status === 416) {
          res.status(416).json({ error: "Range Not Satisfiable" });
          return;
        }
      }
      next(error);
    });
  },
);

/**
 * Return the captured log for a single run. While a run is still executing
 * we serve the live in-memory buffer so the UI can tail output; once the
 * row is finalized we fall back to the persisted `logContent`. The runner
 * hard-caps the stored content at {@link RUN_LOG_MAX_BYTES}, so the
 * endpoint never has to worry about runaway sizes. Status fields ride
 * along so callers can poll a single endpoint to drive a live-log modal.
 */
routinesRouter.get("/runs/:runId/log", async (req, res) => {
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: req.params.runId });
  if (!run) return res.status(404).json({ error: "Not found" });
  // Confirm the caller has access to the parent routine (company scope).
  const found = await loadRoutine((req.params as Record<string, string>).cid, run.routineId);
  if (!found) return res.status(404).json({ error: "Not found" });

  const live = getLiveRunSnapshot(run.id);
  const content = live ? live.content : (run.logContent ?? "");
  const size = live ? live.size : Buffer.byteLength(content, "utf8");
  const truncated = live ? live.truncated : size >= RUN_LOG_MAX_BYTES;
  const browserRecordings = await recordingsVisibleToRequester(req, run);

  res.json({
    content,
    truncated,
    size,
    live: live !== null,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    // So the live-log modal can say "retrying in 2m" without a second request.
    retryAt: run.retryAt,
    attempt: run.attempt,
    // The outcome check lands shortly after a completed run finalizes; polling
    // this endpoint picks the verdict up without a second request.
    outcomeVerdict: run.outcomeVerdict,
    outcomeNote: run.outcomeNote,
    // True while a verdict is still owed — the routine declares acceptance
    // criteria and this completed run has not been graded yet. The live-log
    // modal polls on this rather than guessing how long a check takes.
    awaitingOutcome:
      run.status === "completed" &&
      run.outcomeVerdict === null &&
      found.routine.acceptanceCriteria.trim().length > 0,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    browserRecordings,
  });
});

/**
 * Acknowledge a failed/timed-out run so it drops off the Home "Failed
 * routines" panel and the System Health "Failed routine runs" check. The run
 * row is left intact — this only stamps `dismissedAt` so the alert stops
 * nagging every member. Idempotent: re-dismissing a dismissed run is a no-op.
 */
routinesRouter.post("/runs/:runId/dismiss", async (req, res) => {
  const runRepo = AppDataSource.getRepository(Run);
  const run = await runRepo.findOneBy({ id: req.params.runId });
  if (!run) return res.status(404).json({ error: "Not found" });
  // Company-scope the run through its owning routine.
  const found = await loadRoutine((req.params as Record<string, string>).cid, run.routineId);
  if (!found) return res.status(404).json({ error: "Not found" });
  if (run.status !== "failed" && run.status !== "timeout" && run.status !== "interrupted") {
    return res
      .status(409)
      .json({ error: "Only failed, timed-out, or interrupted runs can be dismissed" });
  }
  if (!run.dismissedAt) {
    run.dismissedAt = new Date();
    await runRepo.save(run);
    await recordAudit({
      companyId: found.co.id,
      actorUserId: req.userId ?? null,
      action: "routine.run.dismiss",
      targetType: "run",
      targetId: run.id,
      targetLabel: found.routine.name,
      metadata: { routineId: found.routine.id, status: run.status },
    });
  }
  res.json(run);
});

const cancelRetrySchema = z.object({}).strict();

/**
 * Cancel a pending automatic retry without disabling the whole routine —
 * the escape hatch for a failure a human has decided to fix by hand. Clearing
 * `retryAt` also un-suppresses the run in the Home failed-routines panel,
 * since it is now a failure nobody is going to re-attempt.
 */
routinesRouter.post(
  "/runs/:runId/cancel-retry",
  validateBody(cancelRetrySchema),
  async (req, res) => {
    const runRepo = AppDataSource.getRepository(Run);
    const run = await runRepo.findOneBy({ id: req.params.runId });
    if (!run) return res.status(404).json({ error: "Not found" });
    const found = await loadRoutine((req.params as Record<string, string>).cid, run.routineId);
    if (!found) return res.status(404).json({ error: "Not found" });
    const outcome = await cancelPendingRetry(run.id);
    if (outcome === "none") {
      return res.status(409).json({ error: "This run has no retry scheduled" });
    }
    if (outcome === "dispatching") {
      return res.status(409).json({ error: "This retry is already starting" });
    }
    if (outcome === "changed") {
      return res.status(409).json({ error: "The retry changed; refresh and try again" });
    }
    await recordAudit({
      companyId: found.co.id,
      actorUserId: req.userId ?? null,
      action: "routine.run.cancelRetry",
      targetType: "run",
      targetId: run.id,
      targetLabel: found.routine.name,
      metadata: { routineId: found.routine.id, attempt: run.attempt },
    });
    res.json({ ...run, retryAt: null });
  },
);
