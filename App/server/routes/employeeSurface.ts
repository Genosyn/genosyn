import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { chatWithEmployee } from "../services/chat.js";
import {
  buildTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../services/workspace.js";

/**
 * Chat + workspace endpoints. Split from `employees.ts` to keep the employee
 * CRUD file focused — these two surfaces reach into the runner seam and the
 * filesystem respectively, which is a different concern from DB bookkeeping.
 */
export const employeeSurfaceRouter = Router({ mergeParams: true });
employeeSurfaceRouter.use(requireAuth);
employeeSurfaceRouter.use(requireCompanyMember);

async function loadEmpAndCompany(
  cid: string,
  eid: string,
): Promise<{ emp: AIEmployee; co: Company } | null> {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return null;
  return { emp, co };
}

// ---------- Chat ----------

const chatSchema = z.object({
  message: z.string().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      }),
    )
    .max(40)
    .optional(),
});

employeeSurfaceRouter.post(
  "/:eid/chat",
  validateBody(chatSchema),
  async (req, res, next) => {
    try {
      const { cid, eid } = req.params as Record<string, string>;
      const body = req.body as z.infer<typeof chatSchema>;
      const result = await chatWithEmployee(cid, eid, body.message, body.history ?? []);
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// ---------- Workspace ----------

employeeSurfaceRouter.get("/:eid/workspace/tree", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  res.json(buildTree(loaded.co.slug, loaded.emp.slug));
});

employeeSurfaceRouter.get("/:eid/workspace/file", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  if (!rel) return res.status(400).json({ error: "Missing path" });
  const loaded = await loadEmpAndCompany(cid, eid);
  if (!loaded) return res.status(404).json({ error: "Not found" });
  const file = readWorkspaceFile(loaded.co.slug, loaded.emp.slug, rel);
  if (file === null) return res.status(400).json({ error: "Invalid path" });
  res.json(file);
});

const writeSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
});

employeeSurfaceRouter.put(
  "/:eid/workspace/file",
  validateBody(writeSchema),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof writeSchema>;
    const loaded = await loadEmpAndCompany(cid, eid);
    if (!loaded) return res.status(404).json({ error: "Not found" });
    const result = writeWorkspaceFile(loaded.co.slug, loaded.emp.slug, body.path, body.content);
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  },
);
