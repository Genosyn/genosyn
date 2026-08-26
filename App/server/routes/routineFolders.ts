import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import {
  createFolder,
  deleteFolder,
  listFoldersWithMeta,
  MAX_FOLDER_DEPTH,
  RoutineFolderError,
  unfiledRoutineCount,
  updateFolder,
} from "../services/routineFolders.js";

/**
 * Routine folders — the filing tree behind the Routines sidebar.
 *
 * A separate router from `routes/routines.ts` because folders are their own
 * resource with their own lifecycle; the routine endpoints only ever *point*
 * at one. Mutations are admin-gated to match the routine surface itself —
 * re-filing the company's whole schedule is the same class of act as editing
 * the routines in it.
 */
export const routineFoldersRouter = Router({ mergeParams: true });
routineFoldersRouter.use(requireAuth);
routineFoldersRouter.use(requireCompanyMember);
routineFoldersRouter.use(
  onRoutePaths(["/routine-folders"], requireCompanyRoleForMutations("admin")),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const folderParamsSchema = z
  .object({ cid: z.string().uuid(), fid: z.string().uuid() })
  .strict();

/**
 * The whole tree in one call, flat, each row carrying its `parentId`, `depth`,
 * `path`, and both routine counts. Flat rather than nested because the sidebar
 * renders an indented list and the index page needs to look a folder up by id
 * — a nested payload would force both to re-flatten it.
 */
routineFoldersRouter.get(
  "/routine-folders",
  validateParams(companyParamsSchema),
  async (req, res) => {
    const [folders, unfiledCount] = await Promise.all([
      listFoldersWithMeta(req.params.cid),
      unfiledRoutineCount(req.params.cid),
    ]);
    res.json({ folders, unfiledCount, maxDepth: MAX_FOLDER_DEPTH });
  },
);

const createSchema = z.object({
  name: z.string().min(1).max(60),
  parentId: z.string().uuid().nullable().optional(),
});

routineFoldersRouter.post(
  "/routine-folders",
  validateParams(companyParamsSchema),
  validateBody(createSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof createSchema>;
    try {
      const folder = await createFolder(cid, {
        name: body.name,
        parentId: body.parentId ?? null,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "routine.folder.create",
        targetType: "routine_folder",
        targetId: folder.id,
        targetLabel: folder.name,
        metadata: { parentId: folder.parentId },
      });
      res.json(folder);
    } catch (err) {
      if (!(err instanceof RoutineFolderError)) throw err;
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
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");

routineFoldersRouter.patch(
  "/routine-folders/:fid",
  validateParams(folderParamsSchema),
  validateBody(patchSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof patchSchema>;
    try {
      const folder = await updateFolder(cid, req.params.fid, body);
      if (!folder) return res.status(404).json({ error: "Folder not found" });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "routine.folder.update",
        targetType: "routine_folder",
        targetId: folder.id,
        targetLabel: folder.name,
        metadata: { changes: body },
      });
      res.json(folder);
    } catch (err) {
      if (!(err instanceof RoutineFolderError)) throw err;
      res.status(400).json({ error: err.message });
    }
  },
);

/**
 * Delete a folder. Its subfolders and routines are promoted to its parent —
 * never deleted — so the response reports how much moved and where, which is
 * what the confirmation dialog quotes back before you press the button.
 */
routineFoldersRouter.delete(
  "/routine-folders/:fid",
  validateParams(folderParamsSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const result = await deleteFolder(cid, req.params.fid);
    if (!result) return res.status(404).json({ error: "Folder not found" });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "routine.folder.delete",
      targetType: "routine_folder",
      targetId: result.folder.id,
      targetLabel: result.folder.name,
      metadata: {
        movedRoutines: result.movedRoutines,
        movedFolders: result.movedFolders,
        promotedTo: result.folder.parentId,
      },
    });
    res.json({
      ok: true,
      movedRoutines: result.movedRoutines,
      movedFolders: result.movedFolders,
      promotedTo: result.folder.parentId,
    });
  },
);
