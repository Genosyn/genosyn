import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import {
  TAGGABLE_RESOURCE_TYPES,
  TagConflictError,
  createCompanyTag,
  deleteCompanyTag,
  listCompanyTags,
  renameCompanyTag,
  replaceResourceTags,
  taggableResourceExists,
  tagsForResource,
} from "../services/tags.js";

export const tagsRouter = Router({ mergeParams: true });
tagsRouter.use(requireAuth);
tagsRouter.use(requireCompanyMember);

const tagNameSchema = z.object({ name: z.string().trim().min(1).max(50) }).strict();
const tagIdParamsSchema = z.object({ tagId: z.string().uuid() });
const resourceParamsSchema = z.object({
  resourceType: z.enum(TAGGABLE_RESOURCE_TYPES),
  resourceId: z.string().uuid(),
});
const assignmentSchema = z.object({ tagIds: z.array(z.string().uuid()).max(20) }).strict();

tagsRouter.get("/tags", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  res.json(await listCompanyTags(cid));
});

tagsRouter.post("/tags", validateBody(tagNameSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof tagNameSchema>;
  res.status(201).json(await createCompanyTag(cid, body.name));
});

tagsRouter.patch("/tags/:tagId", validateBody(tagNameSchema), async (req, res) => {
  const params = tagIdParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid tag id" });
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof tagNameSchema>;
  try {
    const tag = await renameCompanyTag(cid, params.data.tagId, body.name);
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    res.json(tag);
  } catch (err) {
    if (err instanceof TagConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

tagsRouter.delete("/tags/:tagId", async (req, res) => {
  const params = tagIdParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid tag id" });
  const cid = (req.params as Record<string, string>).cid;
  const tag = await deleteCompanyTag(cid, params.data.tagId);
  if (!tag) return res.status(404).json({ error: "Tag not found" });
  res.json({ ok: true });
});

tagsRouter.get("/tags/resources/:resourceType/:resourceId", async (req, res) => {
  const params = resourceParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid resource" });
  const cid = (req.params as Record<string, string>).cid;
  if (!(await taggableResourceExists(cid, params.data.resourceType, params.data.resourceId))) {
    return res.status(404).json({ error: "Resource not found" });
  }
  res.json(await tagsForResource(cid, params.data.resourceType, params.data.resourceId));
});

tagsRouter.put(
  "/tags/resources/:resourceType/:resourceId",
  validateBody(assignmentSchema),
  async (req, res) => {
    const params = resourceParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid resource" });
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof assignmentSchema>;
    try {
      res.json(
        await replaceResourceTags(
          cid,
          params.data.resourceType,
          params.data.resourceId,
          body.tagIds,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === "Resource not found" ? 404 : 400).json({ error: message });
    }
  },
);
