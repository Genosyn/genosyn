import { Router } from "express";
import { Between, In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";

export const inboxRouter = Router({ mergeParams: true });
inboxRouter.use(requireAuth);
inboxRouter.use(requireCompanyMember);

/**
 * Company-wide rollup of today's (or any date's) journal entries across
 * every AI employee. Powers the "Inbox" top-nav: humans get a single feed
 * of what every AI did, instead of clicking into each employee's Journal.
 *
 * Date is interpreted in the server's local timezone for now — good enough
 * for a single-tenant self-hosted dev box. Multi-tenant deployments can
 * later let users pick a tz on their profile.
 */
inboxRouter.get("/inbox", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });

  const dateRaw =
    typeof req.query.date === "string" ? req.query.date : null;
  const target = dateRaw ? new Date(`${dateRaw}T00:00:00`) : new Date();
  if (Number.isNaN(target.getTime())) {
    return res.status(400).json({ error: "Invalid date" });
  }
  const start = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const empRepo = AppDataSource.getRepository(AIEmployee);
  const employees = await empRepo.find({ where: { companyId: cid } });
  if (employees.length === 0) {
    return res.json({
      date: start.toISOString().slice(0, 10),
      employees: [],
      totalEntries: 0,
    });
  }
  const empIds = employees.map((e) => e.id);
  const empById = new Map(employees.map((e) => [e.id, e]));

  const entries = await AppDataSource.getRepository(JournalEntry).find({
    where: {
      employeeId: In(empIds),
      createdAt: Between(start, end),
    },
    order: { createdAt: "DESC" },
  });

  const byEmployee = new Map<
    string,
    { employee: ReturnType<typeof serializeEmployee>; entries: ReturnType<typeof serializeEntry>[] }
  >();
  for (const e of entries) {
    const emp = empById.get(e.employeeId);
    if (!emp) continue;
    let bucket = byEmployee.get(emp.id);
    if (!bucket) {
      bucket = { employee: serializeEmployee(emp), entries: [] };
      byEmployee.set(emp.id, bucket);
    }
    bucket.entries.push(serializeEntry(e));
  }

  // Most-active first; ties sorted alphabetically.
  const groups = Array.from(byEmployee.values()).sort((a, b) => {
    if (b.entries.length !== a.entries.length) {
      return b.entries.length - a.entries.length;
    }
    return a.employee.name.localeCompare(b.employee.name);
  });

  res.json({
    date: start.toISOString().slice(0, 10),
    employees: groups,
    totalEntries: entries.length,
  });
});

function serializeEmployee(e: AIEmployee) {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    role: e.role,
    avatarKey: e.avatarKey ?? null,
  };
}

function serializeEntry(e: JournalEntry) {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    body: e.body,
    runId: e.runId,
    routineId: e.routineId,
    createdAt: e.createdAt.toISOString(),
  };
}
