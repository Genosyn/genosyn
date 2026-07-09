import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";

/**
 * Instance-wide admin endpoints. Not company-scoped — these describe the whole
 * deployment (database, migrations, disk, runtime). Any authenticated user may
 * read them, matching the install-wide backups router: the report exposes no
 * per-company data and self-hosted operators already control access via who
 * can sign in.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/instance-health", async (_req, res, next) => {
  try {
    res.json(await getInstanceHealthReport());
  } catch (err) {
    next(err);
  }
});
