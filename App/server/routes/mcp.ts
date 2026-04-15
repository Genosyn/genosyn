import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { McpServer } from "../db/entities/McpServer.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

/**
 * Per-employee MCP servers. Mounted under /companies/:cid/employees/:eid/.
 * Changes take effect on the next spawn — the runner / chat service rewrites
 * `.mcp.json` at the employee's workspace each time.
 */
export const mcpRouter = Router({ mergeParams: true });
mcpRouter.use(requireAuth);
mcpRouter.use(requireCompanyMember);

async function loadEmp(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
}

function serialize(s: McpServer) {
  return {
    id: s.id,
    employeeId: s.employeeId,
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.argsJson ? safeParseArray(s.argsJson) : [],
    env: s.envJson ? safeParseRecord(s.envJson) : {},
    url: s.url,
    enabled: s.enabled,
    createdAt: s.createdAt,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function safeParseRecord(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

mcpRouter.get("/", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const emp = await loadEmp(cid, eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const servers = await AppDataSource.getRepository(McpServer).find({
    where: { employeeId: emp.id },
    order: { createdAt: "ASC" },
  });
  res.json(servers.map(serialize));
});

const createSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/, "Letters, digits, dot, underscore, hyphen only"),
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(500).optional(),
    args: z.array(z.string().max(500)).max(50).optional(),
    env: z.record(z.string().max(4000)).optional(),
    url: z.string().url().max(2000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      (v.transport === "stdio" && typeof v.command === "string" && v.command.length > 0) ||
      (v.transport === "http" && typeof v.url === "string" && v.url.length > 0),
    "stdio needs command; http needs url",
  );

mcpRouter.post("/", validateBody(createSchema), async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const emp = await loadEmp(cid, eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const body = req.body as z.infer<typeof createSchema>;
  const repo = AppDataSource.getRepository(McpServer);
  const existing = await repo.findOneBy({ employeeId: emp.id, name: body.name });
  if (existing) return res.status(409).json({ error: "An MCP server with that name already exists" });
  const s = repo.create({
    employeeId: emp.id,
    name: body.name,
    transport: body.transport,
    command: body.transport === "stdio" ? body.command ?? null : null,
    argsJson: body.transport === "stdio" && body.args ? JSON.stringify(body.args) : null,
    envJson: body.env ? JSON.stringify(body.env) : null,
    url: body.transport === "http" ? body.url ?? null : null,
    enabled: body.enabled ?? true,
  });
  await repo.save(s);
  res.json(serialize(s));
});

mcpRouter.delete("/:sid", async (req, res) => {
  const { cid, eid, sid } = req.params as Record<string, string>;
  const emp = await loadEmp(cid, eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const repo = AppDataSource.getRepository(McpServer);
  const s = await repo.findOneBy({ id: sid, employeeId: emp.id });
  if (!s) return res.status(404).json({ error: "Not found" });
  await repo.delete({ id: s.id });
  res.json({ ok: true });
});
