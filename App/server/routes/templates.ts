import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { EMPLOYEE_TEMPLATES, TEMPLATE_CATEGORIES } from "../services/templates.js";

/**
 * Global catalogue of employee templates. Not company-scoped — the list is
 * static and identical for every install, so we don't bother namespacing.
 * Only auth is required (so the payload doesn't leak to anonymous crawlers).
 */
export const templatesRouter = Router();
templatesRouter.use(requireAuth);

templatesRouter.get("/employee-templates", (_req, res) => {
  // Return templates grouped by the canonical category order so the hire
  // screen can render labeled sections without owning the ordering itself.
  res.json(
    TEMPLATE_CATEGORIES.flatMap((category) =>
      EMPLOYEE_TEMPLATES.filter((t) => t.category === category).map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        category: t.category,
        tagline: t.tagline,
        skills: t.skills.map((s) => s.name),
        routines: t.routines.map((r) => ({ name: r.name, cronExpr: r.cronExpr })),
      })),
    ),
  );
});
