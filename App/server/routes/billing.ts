import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import {
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  billingEnabled,
  getBillingSettings,
  getStripeSecrets,
} from "../services/billing/billingSettings.js";
import {
  billingSummary,
  countCompanyAiEmployees,
  getOrCreateBillingRow,
  setStripeCustomerId,
  syncFromStripe,
} from "../services/billing/companyBilling.js";
import {
  StripeApiError,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
} from "../services/billing/stripe.js";
import { getCompanyEntitlements } from "../services/entitlements.js";
import { getPublicUrl, isPublicUrlConfigured } from "../services/publicUrl.js";

/**
 * Company billing (M56) — the Plan page's backend on a Genosyn Cloud install.
 * Reading the plan state is an admin concern; starting a checkout or opening
 * the Stripe portal spends the company's money, so those two are owner-only.
 */
export const billingRouter = Router({ mergeParams: true });
billingRouter.use(requireAuth);
billingRouter.use(requireCompanyMember);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();

function failStripe(res: import("express").Response, err: unknown): void {
  if (!(err instanceof StripeApiError)) throw err;
  res.status(400).json({ error: err.message });
}

billingRouter.get(
  "/billing",
  requireCompanyRole("admin"),
  validateParams(companyParamsSchema),
  async (req, res) => {
    res.json(await billingSummary(req.params.cid));
  },
);

const checkoutSchema = z.object({ plan: z.enum(["growth", "scale"]) }).strict();

billingRouter.post(
  "/billing/checkout",
  requireCompanyRole("owner"),
  validateParams(companyParamsSchema),
  validateBody(checkoutSchema),
  async (req, res) => {
    const cid = req.params.cid;
    const { plan } = req.body as z.infer<typeof checkoutSchema>;
    if (!(await billingEnabled())) {
      return res.status(400).json({ error: "Billing is not enabled on this install." });
    }
    const settings = await getBillingSettings();
    const { secretKey } = await getStripeSecrets();
    const priceId = plan === "growth" ? settings.growthPriceId : settings.scalePriceId;
    if (!secretKey || !priceId) {
      return res.status(400).json({ error: "Stripe is not configured on this install." });
    }
    if (!isPublicUrlConfigured()) {
      return res.status(400).json({
        error: "Set the public URL at Admin → General before starting a checkout.",
      });
    }
    const entitlements = await getCompanyEntitlements(cid);
    if (entitlements.plan === plan) {
      return res.status(400).json({ error: `This company is already on the ${plan} plan.` });
    }
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    if (!company) return res.status(404).json({ error: "Company not found" });

    try {
      const row = await getOrCreateBillingRow(cid);
      let customerId = row.stripeCustomerId;
      if (!customerId) {
        customerId = await createCustomer(secretKey, {
          name: company.name,
          email: req.user?.email ?? null,
          companyId: cid,
        });
        await setStripeCustomerId(cid, customerId);
      }
      const base = `${getPublicUrl()}/c/${company.slug}/settings/billing`;
      const quantity = Math.max(1, await countCompanyAiEmployees(cid));
      const session = await createCheckoutSession(secretKey, {
        customerId,
        priceId,
        quantity,
        companyId: cid,
        successUrl: `${base}?checkout=success`,
        cancelUrl: `${base}?checkout=canceled`,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "billing.checkout_started",
        targetType: "billing",
        targetId: cid,
        metadata: { plan, quantity },
      });
      res.json({ url: session.url });
    } catch (err) {
      failStripe(res, err);
    }
  },
);

billingRouter.post(
  "/billing/portal",
  requireCompanyRole("owner"),
  validateParams(companyParamsSchema),
  async (req, res) => {
    const cid = req.params.cid;
    if (!(await billingEnabled())) {
      return res.status(400).json({ error: "Billing is not enabled on this install." });
    }
    const { secretKey } = await getStripeSecrets();
    if (!secretKey) {
      return res.status(400).json({ error: "Stripe is not configured on this install." });
    }
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    if (!company) return res.status(404).json({ error: "Company not found" });
    const row = await getOrCreateBillingRow(cid);
    if (!row.stripeCustomerId) {
      return res.status(400).json({
        error: "This company has no billing account yet — start a checkout first.",
      });
    }
    try {
      const session = await createPortalSession(secretKey, {
        customerId: row.stripeCustomerId,
        returnUrl: `${getPublicUrl()}/c/${company.slug}/settings/billing`,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "billing.portal_opened",
        targetType: "billing",
        targetId: cid,
      });
      res.json({ url: session.url });
    } catch (err) {
      failStripe(res, err);
    }
  },
);

billingRouter.post(
  "/billing/sync",
  requireCompanyRole("admin"),
  validateParams(companyParamsSchema),
  async (req, res) => {
    try {
      res.json(await syncFromStripe(req.params.cid));
    } catch (err) {
      failStripe(res, err);
    }
  },
);
