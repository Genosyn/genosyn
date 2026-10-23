import { Router, type Request, type Response } from "express";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { EMPLOYEE_TEMPLATES, TEMPLATE_CATEGORIES } from "../services/templates.js";

/**
 * Global catalogue of employee templates. Not company-scoped — the list is
 * static and identical for every install, so we don't bother namespacing.
 * Only auth is required (so the payload doesn't leak to anonymous crawlers).
 */
export const templatesRouter = Router();
templatesRouter.use(requireAuth);

function listEmployeeTemplates(_req: Request, res: Response) {
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
}

templatesRouter.get("/employee-templates", listEmployeeTemplates);

// The same catalogue below a company, where an API key — which only works for
// its own company's paths — can read it to hire from a template.
templatesRouter.get(
  "/companies/:cid/employee-templates",
  requireCompanyMember,
  listEmployeeTemplates,
);
