import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  clearCompanySso,
  describeCompanySso,
  updateCompanySso,
} from "../services/companySso.js";
import { discoverOidcEndpoints, SsoLoginError } from "../services/ssoLogin.js";

/**
 * Settings → Single sign-on (M56 Phase B) — a company's own SSO, mounted
 * under `/api/companies/:cid`. Every route here is admin-level: reading,
 * saving, clearing, and probing an issuer.
 */
export const companySsoRouter = Router({ mergeParams: true });
companySsoRouter.use(requireAuth);
companySsoRouter.use(requireCompanyMember);
companySsoRouter.use(onRoutePaths(["/sso"], requireCompanyRole("admin")));

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();

async function companySlug(cid: string): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  return company?.slug ?? "";
}

companySsoRouter.get(
  "/sso",
  validateParams(companyParamsSchema),
  async (req, res, next) => {
    try {
      const cid = req.params.cid;
      res.json(await describeCompanySso(cid, await companySlug(cid)));
    } catch (err) {
      next(err);
    }
  },
);

const ssoSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["google", "oidc"]),
  displayName: z.string().max(60),
  issuer: z.string().max(500),
  clientId: z.string().max(500),
  // Blank means "keep the client secret currently stored".
  clientSecret: z.string().max(2000),
  autoJoin: z.boolean(),
  // Comma-separated email domains; the service normalizes and validates.
  allowedEmailDomains: z.string().max(500),
});

companySsoRouter.put(
  "/sso",
  validateParams(companyParamsSchema),
  validateBody(ssoSchema),
  async (req, res, next) => {
    const cid = req.params.cid;
    const body = req.body as z.infer<typeof ssoSchema>;
    // The write is the only fallible-by-user step: an incomplete config that
    // tries to enable SSO comes back as a 400 the form renders inline.
    try {
      res.json(await updateCompanySso(cid, await companySlug(cid), body));
    } catch (err) {
      if (err instanceof Error && !(err instanceof TypeError)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  },
);

companySsoRouter.delete(
  "/sso",
  validateParams(companyParamsSchema),
  async (req, res, next) => {
    try {
      const cid = req.params.cid;
      res.json(await clearCompanySso(cid, await companySlug(cid)));
    } catch (err) {
      next(err);
    }
  },
);

const ssoTestSchema = z.object({ issuer: z.string().min(1).max(500) });

/**
 * Probe an issuer's OIDC discovery document before the admin commits to it —
 * same harmless probe the instance Admin → SSO page runs.
 */
companySsoRouter.post(
  "/sso/test",
  validateParams(companyParamsSchema),
  validateBody(ssoTestSchema),
  async (req, res, next) => {
    const { issuer } = req.body as z.infer<typeof ssoTestSchema>;
    try {
      const endpoints = await discoverOidcEndpoints(issuer);
      res.json({ ok: true, ...endpoints });
    } catch (err) {
      if (err instanceof SsoLoginError) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      next(err);
    }
  },
);
