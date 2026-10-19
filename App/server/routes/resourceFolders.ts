import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import {
  createResourceFolder,
  deleteResourceFolder,
  listResourceFoldersWithMeta,
  RESOURCE_FOLDER_MAX_DEPTH,
  ResourceFolderError,
  unfiledResourceCount,
  updateResourceFolder,
} from "../services/resourceFolders.js";

/**
 * Resource folders — the files-and-folders tree of the Resources library.
 *
 * Its own path (`/resource-folders`) rather than `/resources/folders`, which
 * `GET /resources/:slug` would have to share with a Resource whose slug is
 * `folders`. Any Member may file the library, exactly as any Member may add,
 * edit, or delete the Resources in it; only who among the AI Employees may
 * write is admin-gated (Resources → AI access).
 */
export const resourceFoldersRouter = Router({ mergeParams: true });
resourceFoldersRouter.use(requireAuth);
resourceFoldersRouter.use(requireCompanyMember);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const folderParamsSchema = z.object({ cid: z.string().uuid(), fid: z.string().uuid() }).strict();

/**
 * The whole tree in one call, flat: each row carries its `parentId`, `depth`,
 * `path`, and both Resource counts, beside the Unfiled count and the depth cap.
 */
resourceFoldersRouter.get(
  "/resource-folders",
  validateParams(companyParamsSchema),
  async (req, res) => {
    const [folders, unfiledCount] = await Promise.all([
      listResourceFoldersWithMeta(req.params.cid),
      unfiledResourceCount(req.params.cid),
    ]);
    res.json({ folders, unfiledCount, maxDepth: RESOURCE_FOLDER_MAX_DEPTH });
  },
);

const createSchema = z
  .object({
    name: z.string().min(1).max(60),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict();

resourceFoldersRouter.post(
  "/resource-folders",
  validateParams(companyParamsSchema),
  validateBody(createSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof createSchema>;
    try {
      const folder = await createResourceFolder(cid, {
        name: body.name,
        parentId: body.parentId ?? null,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "resource.folder.create",
        targetType: "resource_folder",
        targetId: folder.id,
        targetLabel: folder.name,
        metadata: { parentId: folder.parentId },
      });
      res.status(201).json(folder);
    } catch (err) {
      if (!(err instanceof ResourceFolderError)) throw err;
      res.status(400).json({ error: err.message });
    }
  },
);

const patchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    // Null moves the folder back to the top level.
    parentId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");

resourceFoldersRouter.patch(
  "/resource-folders/:fid",
  validateParams(folderParamsSchema),
  validateBody(patchSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof patchSchema>;
    try {
      const folder = await updateResourceFolder(cid, req.params.fid, body);
      if (!folder) return res.status(404).json({ error: "Folder not found" });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "resource.folder.update",
        targetType: "resource_folder",
        targetId: folder.id,
        targetLabel: folder.name,
        metadata: { changes: body },
      });
      res.json(folder);
    } catch (err) {
      if (!(err instanceof ResourceFolderError)) throw err;
      res.status(400).json({ error: err.message });
    }
  },
);

/**
 * Delete a folder. What was inside moves up to its parent — never deleted —
 * and the response says how much moved, which the confirmation quotes.
 */
resourceFoldersRouter.delete(
  "/resource-folders/:fid",
  validateParams(folderParamsSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const result = await deleteResourceFolder(cid, req.params.fid);
    if (!result) return res.status(404).json({ error: "Folder not found" });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "resource.folder.delete",
      targetType: "resource_folder",
      targetId: result.folder.id,
      targetLabel: result.folder.name,
      metadata: {
        movedResources: result.movedResources,
        movedFolders: result.movedFolders,
        promotedTo: result.folder.parentId,
      },
    });
    res.json({
      ok: true,
      movedResources: result.movedResources,
      movedFolders: result.movedFolders,
      promotedTo: result.folder.parentId,
    });
  },
);
