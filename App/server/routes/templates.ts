import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { EMPLOYEE_TEMPLATES } from "../services/templates.js";

/**
 * Global catalogue of employee templates. Not company-scoped — the list is
 * static and identical for every install, so we don't bother namespacing.
 * Only auth is required (so the payload doesn't leak to anonymous crawlers).
 */
export const templatesRouter = Router();
templatesRouter.use(requireAuth);

templatesRouter.get("/employee-templates", (_req, res) => {
  res.json(
    EMPLOYEE_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      tagline: t.tagline,
      skills: t.skills.map((s) => s.name),
      routines: t.routines.map((r) => ({ name: r.name, cronExpr: r.cronExpr })),
    })),
  );
});
