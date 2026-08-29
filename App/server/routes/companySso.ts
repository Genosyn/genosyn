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
import { featureGateMessage, getCompanyEntitlements } from "../services/entitlements.js";
import { discoverOidcEndpoints, SsoLoginError } from "../services/ssoLogin.js";

/**
 * Settings → Single sign-on (M56 Phase B) — a company's own SSO on a Genosyn
 * Cloud install, mounted under `/api/companies/:cid`.
 *
 * Reading is admin-level so the page can always render its state (including
 * the upgrade gate). Turning SSO ON is the Scale-plan feature: the PUT
 * refuses `enabled: true` without the `sso` entitlement, mirroring how the
 * instance SSO is license-gated on self-hosted installs. Saving a draft
 * configuration or turning it off is never gated — losing a plan must not
 * lock a company out of its own settings.
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
    try {
      if (body.enabled) {
        const entitlements = await getCompanyEntitlements(cid);
        if (!entitlements.features.sso) {
          return res
            .status(402)
            .json({ error: featureGateMessage("sso", entitlements.edition) });
        }
      }
      // The write is the only fallible-by-user step: an incomplete config
      // that tries to enable SSO comes back as a 400 the form renders inline.
      try {
        res.json(await updateCompanySso(cid, await companySlug(cid), body));
      } catch (err) {
        if (err instanceof Error && !(err instanceof TypeError)) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    } catch (err) {
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
