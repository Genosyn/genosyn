import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Handoff, HandoffStatus } from "../db/entities/Handoff.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";

export const handoffsRouter = Router({ mergeParams: true });
handoffsRouter.use(requireAuth);
handoffsRouter.use(requireCompanyMember);

async function loadCompany(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function loadEmployee(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
}

async function loadHandoff(cid: string, hid: string) {
  return AppDataSource.getRepository(Handoff).findOneBy({
    id: hid,
    companyId: cid,
  });
}

type HandoffPayload = ReturnType<typeof serializeHandoff>;

function serializeHandoff(
  h: Handoff,
  from: AIEmployee | null,
  to: AIEmployee | null,
) {
  return {
    id: h.id,
    companyId: h.companyId,
    fromEmployeeId: h.fromEmployeeId,
    toEmployeeId: h.toEmployeeId,
    from: from
      ? { id: from.id, slug: from.slug, name: from.name, role: from.role }
      : null,
    to: to
      ? { id: to.id, slug: to.slug, name: to.name, role: to.role }
      : null,
    title: h.title,
    body: h.body,
    status: h.status,
    resolutionNote: h.resolutionNote,
    dueAt: h.dueAt?.toISOString() ?? null,
    completedAt: h.completedAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

async function hydrateHandoffs(
  rows: Handoff[],
): Promise<HandoffPayload[]> {
  if (rows.length === 0) return [];
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.fromEmployeeId);
    ids.add(r.toEmployeeId);
  }
  const emps = await empRepo
    .createQueryBuilder("e")
    .where("e.id IN (:...ids)", { ids: Array.from(ids) })
    .getMany();
  const byId = new Map(emps.map((e) => [e.id, e]));
  return rows.map((h) =>
    serializeHandoff(h, byId.get(h.fromEmployeeId) ?? null, byId.get(h.toEmployeeId) ?? null),
  );
}

const STATUS_VALUES: HandoffStatus[] = [
  "pending",
  "completed",
  "declined",
  "cancelled",
];

handoffsRouter.get("/handoffs", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await loadCompany(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });

  const employeeId =
    typeof req.query.employeeId === "string" ? req.query.employeeId : null;
  const direction =
    req.query.direction === "incoming"
      ? "incoming"
      : req.query.direction === "outgoing"
        ? "outgoing"
        : null;
  const statusRaw =
    typeof req.query.status === "string" ? req.query.status : null;
  const status: HandoffStatus | null =
    statusRaw && (STATUS_VALUES as string[]).includes(statusRaw)
      ? (statusRaw as HandoffStatus)
      : null;

  const qb = AppDataSource.getRepository(Handoff)
    .createQueryBuilder("h")
    .where("h.companyId = :cid", { cid });

  if (employeeId && direction === "incoming") {
    qb.andWhere("h.toEmployeeId = :eid", { eid: employeeId });
  } else if (employeeId && direction === "outgoing") {
    qb.andWhere("h.fromEmployeeId = :eid", { eid: employeeId });
  } else if (employeeId) {
    qb.andWhere("(h.toEmployeeId = :eid OR h.fromEmployeeId = :eid)", {
      eid: employeeId,
    });
  }
  if (status) qb.andWhere("h.status = :status", { status });
  qb.orderBy("h.createdAt", "DESC").take(200);
  const rows = await qb.getMany();
  res.json(await hydrateHandoffs(rows));
});

handoffsRouter.get("/handoffs/:hid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const h = await loadHandoff(cid, req.params.hid);
  if (!h) return res.status(404).json({ error: "Handoff not found" });
  const [hydrated] = await hydrateHandoffs([h]);
  res.json(hydrated);
});

const createSchema = z
  .object({
    fromEmployeeId: z.string().uuid(),
    toEmployeeId: z.string().uuid(),
    title: z.string().min(1).max(160),
    body: z.string().max(20_000).optional(),
    dueAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((v) => v.fromEmployeeId !== v.toEmployeeId, {
    message: "from and to must differ",
  });

handoffsRouter.post(
  "/handoffs",
  validateBody(createSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const co = await loadCompany(cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof createSchema>;
    const [from, to] = await Promise.all([
      loadEmployee(cid, body.fromEmployeeId),
      loadEmployee(cid, body.toEmployeeId),
    ]);
    if (!from || !to) {
      return res
        .status(404)
        .json({ error: "from / to employee not found in this company" });
    }
    const repo = AppDataSource.getRepository(Handoff);
    const h = repo.create({
      companyId: cid,
      fromEmployeeId: from.id,
      toEmployeeId: to.id,
      title: body.title.trim(),
      body: body.body ?? "",
      status: "pending",
      resolutionNote: null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      completedAt: null,
    });
    await repo.save(h);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "handoff.create",
      targetType: "handoff",
      targetId: h.id,
      targetLabel: h.title,
      metadata: {
        via: "api",
        fromEmployeeId: from.id,
        toEmployeeId: to.id,
      },
    });
    // Mirror to both employees' Journals so the trail is visible from
    // either side.
    const journalRepo = AppDataSource.getRepository(JournalEntry);
    await journalRepo.save([
      journalRepo.create({
        employeeId: from.id,
        kind: "system",
        title: `Handed off "${h.title}" to ${to.name}`,
        body: h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
        runId: null,
        routineId: null,
        authorUserId: req.userId ?? null,
      }),
      journalRepo.create({
        employeeId: to.id,
        kind: "system",
        title: `Received handoff "${h.title}" from ${from.name}`,
        body: h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
        runId: null,
        routineId: null,
        authorUserId: req.userId ?? null,
      }),
    ]);
    const [hydrated] = await hydrateHandoffs([h]);
    res.status(201).json(hydrated);
  },
);

const transitionSchema = z
  .object({ resolutionNote: z.string().max(20_000).optional() })
  .strict();

async function applyTransition(
  cid: string,
  hid: string,
  next: HandoffStatus,
  note: string | null,
  actorUserId: string | null,
): Promise<{ status: number; payload: unknown }> {
  const repo = AppDataSource.getRepository(Handoff);
  const h = await repo.findOneBy({ id: hid, companyId: cid });
  if (!h) return { status: 404, payload: { error: "Handoff not found" } };
  if (h.status !== "pending") {
    return {
      status: 400,
      payload: {
        error: `Handoff is already ${h.status}; only pending handoffs can transition.`,
      },
    };
  }
  h.status = next;
  h.resolutionNote = note;
  h.completedAt = next === "completed" ? new Date() : null;
  await repo.save(h);
  await recordAudit({
    companyId: cid,
    actorUserId: actorUserId,
    action: `handoff.${next}`,
    targetType: "handoff",
    targetId: h.id,
    targetLabel: h.title,
    metadata: { via: "api" },
  });
  const journalRepo = AppDataSource.getRepository(JournalEntry);
  const verb =
    next === "completed"
      ? "completed"
      : next === "declined"
        ? "declined"
        : "cancelled";
  await journalRepo.save([
    journalRepo.create({
      employeeId: h.fromEmployeeId,
      kind: "system",
      title: `Handoff "${h.title}" ${verb}`,
      body: note ?? "",
      runId: null,
      routineId: null,
      authorUserId: actorUserId,
    }),
    journalRepo.create({
      employeeId: h.toEmployeeId,
      kind: "system",
      title: `Handoff "${h.title}" ${verb}`,
      body: note ?? "",
      runId: null,
      routineId: null,
      authorUserId: actorUserId,
    }),
  ]);
  const [hydrated] = await hydrateHandoffs([h]);
  return { status: 200, payload: hydrated };
}

handoffsRouter.post(
  "/handoffs/:hid/complete",
  validateBody(transitionSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof transitionSchema>;
    const out = await applyTransition(
      cid,
      req.params.hid,
      "completed",
      body.resolutionNote ?? null,
      req.userId ?? null,
    );
    res.status(out.status).json(out.payload);
  },
);

handoffsRouter.post(
  "/handoffs/:hid/decline",
  validateBody(transitionSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof transitionSchema>;
    const out = await applyTransition(
      cid,
      req.params.hid,
      "declined",
      body.resolutionNote ?? null,
      req.userId ?? null,
    );
    res.status(out.status).json(out.payload);
  },
);

handoffsRouter.post(
  "/handoffs/:hid/cancel",
  validateBody(transitionSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof transitionSchema>;
    const out = await applyTransition(
      cid,
      req.params.hid,
      "cancelled",
      body.resolutionNote ?? null,
      req.userId ?? null,
    );
    res.status(out.status).json(out.payload);
  },
);
