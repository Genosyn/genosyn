import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";
import { getMigrationReport } from "../services/adminMigrations.js";
import { AdminQueryError, getDbSchema, runAdminQuery } from "../services/adminDbConsole.js";
import { listAdminCompanies, listAdminUsers } from "../services/adminDirectory.js";
import { getSignupSettings, setSignupsDisabled } from "../services/signupSettings.js";
import { clearSsoSettings, describeSso, updateSsoSettings } from "../services/ssoSettings.js";
import { discoverOidcEndpoints, SsoLoginError } from "../services/ssoLogin.js";
import { deleteUserCascade, UserOwnsCompaniesError } from "../services/userDelete.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import { avatarAbsPath, mimeFromKey, removeAvatarFile } from "../services/avatars.js";
import { sendGlobalSmtpTest } from "../services/email.js";
import {
  clearGlobalSmtpOverride,
  describeGlobalSmtp,
  resolveGlobalSmtpDraft,
  updateGlobalSmtpOverride,
} from "../services/globalEmailTransport.js";
import { getPublicUrlSettings, setPublicUrl } from "../services/publicUrl.js";
import {
  getRuntimeSettingsSnapshot,
  resetRuntimeSettingsGroup,
  saveRuntimeSettingsGroup,
} from "../services/runtimeSettings.js";
import type {
  RuntimeSettings,
  RuntimeSettingsGroup,
} from "../services/runtimeSettings.js";
import {
  clearOauthApp,
  describeOauthApps,
  isRegisterableOauthApp,
  saveOauthApp,
} from "../services/oauthApps.js";
import {
  billingEnabled,
  getBillingSettings,
  updateBillingSettings,
} from "../services/billing/billingSettings.js";
import {
  clearInstanceLicenseKey,
  clearSigningPrivateKey,
  getInstanceLicense,
  getSigningPrivateKey,
  isLicenseExpired,
  maskLicenseKey,
  parseLicenseKey,
  setInstanceLicenseKey,
  setSigningPrivateKey,
  signLicense,
  verifyLicenseKey,
  type InstanceLicenseStatus,
  type LicensePayload,
} from "../services/license.js";
import { featureGateMessage } from "../services/entitlements.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EnterpriseLicense } from "../db/entities/EnterpriseLicense.js";
import { randomUUID } from "node:crypto";

/**
 * Instance-wide admin endpoints. Not company-scoped — these describe and manage
 * the whole deployment (health, the global email transport, and the directory
 * of every user + company on it) rather than a single company's data.
 *
 * Auth is `requireAuth` + `requireMasterAdmin`: the Admin section is the
 * operator surface, gated to users carrying the instance-level `isMasterAdmin`
 * flag. The configured bootstrap address receives that flag only after email
 * verification; existing master admins promote others from
 * `PATCH /users/:id/master-admin` below. The destructive routes here (delete
 * user / delete company) and the companion backup-restore route are all held
 * to the same verified master-admin bar.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);
adminRouter.use(requireMasterAdmin);

adminRouter.get("/instance-health", async (_req, res, next) => {
  try {
    res.json(await getInstanceHealthReport());
  } catch (err) {
    next(err);
  }
});

// ─────────────────────── instance-wide settings ───────────────────────────

adminRouter.get("/instance-settings", async (_req, res, next) => {
  try {
    res.json(await getPublicUrlSettings());
  } catch (err) {
    next(err);
  }
});

const instanceSettingsSchema = z.object({
  publicUrl: z.string().min(1).max(2048),
});

adminRouter.put(
  "/instance-settings",
  validateBody(instanceSettingsSchema),
  async (req, res, next) => {
    try {
      const { publicUrl } = req.body as z.infer<typeof instanceSettingsSchema>;
      res.json(await setPublicUrl(publicUrl));
    } catch (err) {
      if (err instanceof Error) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  },
);

/**
 * The per-migration detail behind the Instance Health "schema migrations"
 * check. Read-only, and deliberately has no run/revert companion: boot applies
 * migrations, and a browser-triggered schema mutation isn't a power this
 * surface should hand out. A database that won't answer comes back as a
 * status:"error" report rather than a 500 — see `services/adminMigrations.ts`.
 */
adminRouter.get("/migrations", async (_req, res, next) => {
  try {
    res.json(await getMigrationReport());
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────── database console ──────────────────────────────
//
// A raw query console over Genosyn's own application database, for operators
// who need to inspect or repair the install directly. Master-admin gated (the
// whole router is), read-only by default — a write statement is refused unless
// the caller opts in with `allowWrite`.

adminRouter.get("/db/schema", async (_req, res, next) => {
  try {
    res.json(await getDbSchema());
  } catch (err) {
    next(err);
  }
});

const dbQuerySchema = z.object({
  sql: z.string().min(1).max(100_000),
  allowWrite: z.boolean().optional(),
  maxRows: z.number().int().min(1).max(5000).optional(),
});

adminRouter.post("/db/query", validateBody(dbQuerySchema), async (req, res) => {
  const body = req.body as z.infer<typeof dbQuerySchema>;
  try {
    const result = await runAdminQuery(body.sql, {
      allowWrite: body.allowWrite ?? false,
      maxRows: body.maxRows,
    });
    res.json(result);
  } catch (err) {
    // Both a blocked write and a driver-side SQL error are the operator's to
    // fix — surface the message as a 400 so the console renders it inline
    // rather than as a generic 500.
    if (err instanceof AdminQueryError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ───────────────────── global email transport ──────────────────────────────

adminRouter.get("/email-transport", async (_req, res, next) => {
  try {
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

const smtpFields = {
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255),
  // Blank means "keep the password currently in effect".
  pass: z.string().max(1024),
  // Optional keeps older API clients compatible with the new form field.
  fromName: z.string().max(255).optional(),
  from: z.string().max(255),
};

const saveSchema = z.object(smtpFields);

adminRouter.put("/email-transport", validateBody(saveSchema), async (req, res, next) => {
  const body = req.body as z.infer<typeof saveSchema>;
  // The write is the only fallible-by-user step: a bad payload returns 400.
  try {
    await updateGlobalSmtpOverride(body);
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to save email transport",
    });
  }
  // The save already succeeded — a failure re-reading state to build the
  // response is a server error (500 via next), not a "save failed" 400.
  try {
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

adminRouter.delete("/email-transport", async (_req, res, next) => {
  try {
    await clearGlobalSmtpOverride();
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

const testSchema = z.object({ ...smtpFields, to: z.string().email() });

adminRouter.post("/email-transport/test", validateBody(testSchema), async (req, res) => {
  const body = req.body as z.infer<typeof testSchema>;
  try {
    const settings = await resolveGlobalSmtpDraft(body);
    if (!settings.host) {
      return res.status(400).json({ ok: false, error: "SMTP host is required" });
    }
    const result = await sendGlobalSmtpTest({
      settings,
      to: body.to,
      triggeredByUserId: req.userId ?? null,
    });
    if (result.status === "sent") {
      res.json({
        ok: true,
        logId: result.logId,
        messageId: result.messageId,
      });
    } else {
      res.status(400).json({ ok: false, error: result.errorMessage, logId: result.logId });
    }
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ──────────────────────────── runtime settings ─────────────────────────────
//
// The operational knobs that used to live in `config.ts`: the web tools, mail
// sync tuning, meetings, the container's browser, the agent's taint policy /
// member browsers / tool discovery, containment, and the outbound network
// allowlist. One JSON `AppSetting` row per group, read through a 30s cache —
// see `services/runtimeSettings.ts`.
//
// PUT replaces a whole group rather than patching fields: the form always
// submits every value it showed, and a partial write from a stale form would
// otherwise silently revert whatever it did not know about. DELETE drops the
// row so the group falls back to the shipped defaults. No secrets live in any
// of these groups, so unlike the transport and OAuth routes the GET returns
// every value.

const runtimeGroupParams = z.object({
  group: z.enum(["web", "mail", "meetings", "browser", "agent", "containment", "network"]),
});

const runtimeGroupSchemas = {
  web: z.object({
    enabled: z.boolean(),
    searchProvider: z.enum(["duckduckgo", "disabled"]),
    maxSearchResults: z.number().int().min(1).max(50),
    maxDocumentBytes: z
      .number()
      .int()
      .min(1024)
      .max(200 * 1024 * 1024),
    maxTextChars: z.number().int().min(500).max(1_000_000),
  }),
  mail: z.object({
    syncIntervalSec: z.number().int().min(10).max(86_400),
    backfillThreadsPerPass: z.number().int().min(1).max(5_000),
    backfillPassSeconds: z.number().int().min(1).max(600),
    backfillDays: z.number().int().min(0).max(36_500),
  }),
  meetings: z.object({
    enabled: z.boolean(),
    syncIntervalSeconds: z.number().int().min(60).max(86_400),
    transcriptionModel: z.string().min(1).max(200),
    maxRecordingBytes: z
      .number()
      .int()
      .min(1024)
      .max(100 * 1024 * 1024),
  }),
  browser: z.object({
    executablePath: z.string().max(1024),
    headless: z.union([z.literal("auto"), z.boolean()]),
    locale: z.string().max(64),
    timezone: z.string().max(64),
    humanize: z.boolean(),
  }),
  agent: z.object({
    taintPolicy: z.enum(["web", "off"]),
    memberBrowsersEnabled: z.boolean(),
    toolDiscovery: z.object({
      enabled: z.boolean(),
      minCatalogueSize: z.number().int().min(0).max(10_000),
    }),
  }),
  containment: z.object({
    // 0 disables the breaker. The upper bound is nominal — anything past a
    // few dozen consecutive failures is a Routine nobody is watching anyway.
    routineBreakerThreshold: z.number().int().min(0).max(1_000),
    regradeAfterMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    regradePerPass: z.number().int().min(0).max(200),
  }),
  network: z.object({
    // Hostnames, so 253 characters each and a list an operator can still read.
    // The service normalizes and dedupes on the way in; this is only the outer
    // bound, and an empty list is the shipped default.
    privateHostAllowlist: z.array(z.string().trim().min(1).max(253)).max(100),
  }),
} as const;

adminRouter.get("/runtime-settings", async (_req, res, next) => {
  try {
    res.json(await getRuntimeSettingsSnapshot());
  } catch (err) {
    next(err);
  }
});

adminRouter.put(
  "/runtime-settings/:group",
  validateParams(runtimeGroupParams),
  async (req, res, next) => {
    const { group } = req.params as unknown as z.infer<typeof runtimeGroupParams>;
    // The body schema depends on the path parameter, so it is validated here
    // rather than by `validateBody`, which is bound to one schema per route.
    const parsed = runtimeGroupSchemas[group].safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid runtime settings",
        details: parsed.error.flatten(),
      });
    }
    try {
      // The body schema is chosen by the path parameter, so the correlation
      // between `group` and the parsed value is one TypeScript cannot follow.
      await saveRuntimeSettingsGroup(group, parsed.data as RuntimeSettings[RuntimeSettingsGroup]);
      res.json(await getRuntimeSettingsSnapshot());
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete(
  "/runtime-settings/:group",
  validateParams(runtimeGroupParams),
  async (req, res, next) => {
    const { group } = req.params as unknown as z.infer<typeof runtimeGroupParams>;
    try {
      await resetRuntimeSettingsGroup(group);
      res.json(await getRuntimeSettingsSnapshot());
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────── install-wide OAuth apps ───────────────────────────
//
// Register each provider's OAuth client once for the whole deployment so that
// connecting a mailbox (or any other OAuth integration) needs no Google Cloud
// project per Connection. Secrets are write-only across this boundary: the GET
// returns client ids and a `hasClientSecret` flag, never a secret value.

adminRouter.get("/oauth-apps", async (_req, res, next) => {
  try {
    res.json(await describeOauthApps());
  } catch (err) {
    next(err);
  }
});

const oauthAppParamsSchema = z.object({ app: z.string().min(1).max(32) });
const oauthAppSaveSchema = z.object({
  clientId: z.string().min(1).max(512),
  // Blank means "keep the secret currently stored", so an admin can fix a
  // client id without going back to the provider's console for the secret.
  clientSecret: z.string().max(1024),
});

adminRouter.put(
  "/oauth-apps/:app",
  validateParams(oauthAppParamsSchema),
  validateBody(oauthAppSaveSchema),
  async (req, res, next) => {
    const { app } = req.params as z.infer<typeof oauthAppParamsSchema>;
    if (!isRegisterableOauthApp(app)) {
      return res.status(400).json({ error: `"${app}" is not a registerable OAuth app.` });
    }
    const body = req.body as z.infer<typeof oauthAppSaveSchema>;
    try {
      await saveOauthApp(app, body);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to save the OAuth app",
      });
    }
    // The save landed; a failure re-reading state is a server error, not a
    // "save failed" 400.
    try {
      res.json(await describeOauthApps());
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete(
  "/oauth-apps/:app",
  validateParams(oauthAppParamsSchema),
  async (req, res, next) => {
    const { app } = req.params as z.infer<typeof oauthAppParamsSchema>;
    if (!isRegisterableOauthApp(app)) {
      return res.status(400).json({ error: `"${app}" is not a registerable OAuth app.` });
    }
    try {
      await clearOauthApp(app);
      res.json(await describeOauthApps());
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────────── browser profile ──────────────────────────────
//
// Launches the real browser profile and checks it for the self-contradictions
// that get an AI Employee blocked — a user agent disagreeing with
// `navigator.platform`, a Chrome claim with no Chrome fonts behind it, a patch
// that reads as a patch. POST rather than GET because it starts a browser, and
// admin-only for the same reason: it is a deliberate diagnostic, not something
// a health poll should be able to trigger.

const browserSelfTestSchema = z.object({});

adminRouter.post(
  "/browser-self-test",
  validateBody(browserSelfTestSchema),
  async (_req, res) => {
    try {
      const { runBrowserSelfTest } = await import("../services/browserFingerprint.js");
      res.json({ ok: true, result: await runBrowserSelfTest() });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// ─────────────────────────── sign-up policy ────────────────────────────────
//
// Instance-wide toggle for self-service registration. When disabled, the public
// signup endpoint refuses everyone but the configured, still-unclaimed
// bootstrap address; existing members and invited users are unaffected.

adminRouter.get("/signup-settings", async (_req, res, next) => {
  try {
    res.json(await getSignupSettings());
  } catch (err) {
    next(err);
  }
});

const signupSettingsSchema = z.object({ signupsDisabled: z.boolean() });

adminRouter.put("/signup-settings", validateBody(signupSettingsSchema), async (req, res, next) => {
  try {
    const { signupsDisabled } = req.body as z.infer<typeof signupSettingsSchema>;
    res.json(await setSignupsDisabled(signupsDisabled));
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── SSO sign-in ─────────────────────────────────
//
// Instance-wide single sign-on. Disabled by default; operators configure a
// Google or OpenID Connect client here and the login page grows a
// "Continue with …" button. The client secret is stored encrypted and never
// echoed back — see services/ssoSettings.ts.

adminRouter.get("/sso", async (_req, res, next) => {
  try {
    res.json(await describeSso());
  } catch (err) {
    next(err);
  }
});

const ssoSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["google", "oidc"]),
  displayName: z.string().max(60),
  issuer: z.string().max(500),
  clientId: z.string().max(500),
  // Blank means "keep the client secret currently stored".
  clientSecret: z.string().max(2000),
  autoProvision: z.boolean(),
});

adminRouter.put("/sso", validateBody(ssoSchema), async (req, res, next) => {
  const body = req.body as z.infer<typeof ssoSchema>;
  // Self-hosted installs (billing disabled) need an Enterprise license to turn
  // SSO on (M56). When instance billing is enabled the SSO being configured
  // here is the operator's own sign-in and stays ungated.
  if (body.enabled && !(await billingEnabled())) {
    const license = await getInstanceLicense();
    if (!license.featureValid) {
      return res.status(402).json({ error: featureGateMessage("sso", "community") });
    }
  }
  // The write is the only fallible-by-user step: an incomplete config that
  // tries to enable SSO comes back as a 400 the form renders inline.
  try {
    res.json(await updateSsoSettings(body));
  } catch (err) {
    if (err instanceof Error && !(err instanceof TypeError)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

adminRouter.delete("/sso", async (_req, res, next) => {
  try {
    res.json(await clearSsoSettings());
  } catch (err) {
    next(err);
  }
});

const ssoTestSchema = z.object({ issuer: z.string().min(1).max(500) });

/**
 * Probe an issuer's OIDC discovery document before the operator commits to
 * it — reports the endpoints found, or the reason the issuer can't be used.
 * No credentials are involved, so this is safe to run against a draft.
 */
adminRouter.post("/sso/test", validateBody(ssoTestSchema), async (req, res, next) => {
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
});

// ─────────────────────────── instance billing ──────────────────────────────
//
// M56: whether this install charges companies for Plans (Genosyn Cloud), and
// the Stripe credentials it charges with. Secrets are write-only across this
// boundary — the GET returns `hasSecretKey` / `hasWebhookSecret` flags only.

adminRouter.get("/billing", async (_req, res, next) => {
  try {
    res.json(await getBillingSettings());
  } catch (err) {
    next(err);
  }
});

const billingSettingsSchema = z.object({
  enabled: z.boolean(),
  growthPriceId: z.string().max(255),
  scalePriceId: z.string().max(255),
  // Blank or omitted keeps the stored secret.
  secretKey: z.string().max(1024).optional(),
  webhookSecret: z.string().max(1024).optional(),
});

adminRouter.put("/billing", validateBody(billingSettingsSchema), async (req, res) => {
  const body = req.body as z.infer<typeof billingSettingsSchema>;
  try {
    res.json(await updateBillingSettings(body));
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Failed to save billing settings",
    });
  }
});

// ─────────────────────────── Enterprise license ────────────────────────────
//
// M56: the license activated on THIS install (Admin → License). Verified
// offline against the public keys embedded in `services/license.ts` — see
// that module for the soft/hard expiry semantics.

type AdminLicenseView = {
  status: InstanceLicenseStatus["status"];
  companyName: string | null;
  email: string | null;
  expiresAt: string | null;
  seats: number | null;
  evaluation: boolean;
  aiEmployeeCount: number;
};

async function describeInstanceLicense(): Promise<AdminLicenseView> {
  const license = await getInstanceLicense();
  const aiEmployeeCount = await AppDataSource.getRepository(AIEmployee).count();
  return {
    status: license.status,
    companyName: license.payload?.company ?? null,
    email: license.payload?.email ?? null,
    expiresAt: license.payload?.expiresAt ?? null,
    seats: license.payload?.seats ?? null,
    evaluation: license.payload?.evaluation ?? false,
    aiEmployeeCount,
  };
}

adminRouter.get("/license", async (_req, res, next) => {
  try {
    res.json(await describeInstanceLicense());
  } catch (err) {
    next(err);
  }
});

const licenseKeySchema = z.object({ key: z.string().min(1).max(10_000) });

adminRouter.put("/license", validateBody(licenseKeySchema), async (req, res, next) => {
  const { key } = req.body as z.infer<typeof licenseKeySchema>;
  const verified = verifyLicenseKey(key);
  if (!verified) {
    const parsed = parseLicenseKey(key);
    return res.status(400).json({
      error: parsed
        ? "This license key's signature could not be verified. Check you pasted the whole key."
        : "That is not a Genosyn Enterprise license key.",
    });
  }
  // An expired paid license is accepted (features stay on, the UI warns); an
  // expired evaluation would activate nothing, so refuse it outright.
  if (verified.payload.evaluation && isLicenseExpired(verified.payload)) {
    return res.status(400).json({
      error: "This evaluation license has expired. Contact Genosyn for a new one.",
    });
  }
  try {
    await setInstanceLicenseKey(key);
    res.json(await describeInstanceLicense());
  } catch (err) {
    next(err);
  }
});

adminRouter.delete("/license", async (_req, res, next) => {
  try {
    await clearInstanceLicenseKey();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────── Enterprise license issuance ───────────────────────
//
// The ISSUER's surface (Admin → Enterprise Licenses) — only useful where the
// Ed25519 signing key is configured, i.e. on Genosyn's own cloud install. The
// full signed key appears once, in the POST response; only a masked preview
// is stored in the registry.

function serializeIssuedLicense(row: EnterpriseLicense) {
  return {
    id: row.id,
    companyName: row.companyName,
    email: row.email,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
    seats: row.seats,
    evaluation: row.evaluation,
    keyPreview: row.keyPreview,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

adminRouter.get("/licenses", async (_req, res, next) => {
  try {
    const [signingKey, rows] = await Promise.all([
      getSigningPrivateKey(),
      AppDataSource.getRepository(EnterpriseLicense).find({
        order: { createdAt: "DESC" },
      }),
    ]);
    res.json({
      signingConfigured: Boolean(signingKey),
      licenses: rows.map(serializeIssuedLicense),
    });
  } catch (err) {
    next(err);
  }
});

const issueLicenseSchema = z.object({
  companyName: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .refine((v) => Date.parse(v) > Date.now(), "The expiry date must be in the future"),
  seats: z.number().int().min(1).nullable().optional(),
  evaluation: z.boolean(),
});

adminRouter.post("/licenses", validateBody(issueLicenseSchema), async (req, res, next) => {
  const body = req.body as z.infer<typeof issueLicenseSchema>;
  const signingKey = await getSigningPrivateKey();
  if (!signingKey) {
    return res.status(400).json({
      error: "Configure the license signing key before issuing licenses.",
    });
  }
  try {
    const payload: LicensePayload = {
      v: 1,
      id: randomUUID(),
      company: body.companyName,
      email: body.email ?? null,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(body.expiresAt).toISOString(),
      seats: body.seats ?? null,
      evaluation: body.evaluation,
    };
    const key = signLicense(signingKey, payload);
    const repo = AppDataSource.getRepository(EnterpriseLicense);
    const row = await repo.save(
      repo.create({
        id: payload.id,
        companyName: payload.company,
        email: payload.email,
        expiresAt: new Date(payload.expiresAt),
        seats: payload.seats,
        evaluation: payload.evaluation,
        keyPreview: maskLicenseKey(key),
        createdByUserId: req.userId ?? null,
      }),
    );
    // Instance-level — no companyId, so no recordAudit (which requires one).
    res.json({ license: serializeIssuedLicense(row), key });
  } catch (err) {
    next(err);
  }
});

const signingKeySchema = z.object({ privateKey: z.string().min(1).max(10_000) });

adminRouter.put(
  "/licenses/signing-key",
  validateBody(signingKeySchema),
  async (req, res) => {
    const { privateKey } = req.body as z.infer<typeof signingKeySchema>;
    try {
      await setSigningPrivateKey(privateKey);
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to save the signing key",
      });
    }
    res.json({ signingConfigured: true });
  },
);

adminRouter.delete("/licenses/signing-key", async (_req, res, next) => {
  try {
    await clearSigningPrivateKey();
    res.json({ signingConfigured: false });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────── Users ────────────────────────────────────

const idParam = z.object({ id: z.string().uuid() });

adminRouter.get("/users", async (_req, res, next) => {
  try {
    res.json(await listAdminUsers());
  } catch (err) {
    next(err);
  }
});

/**
 * Serve any user's avatar for the Admin → Users list. Company-scoped avatar
 * routes only resolve a user the caller shares a company with; the admin
 * directory spans every user, so it needs its own instance-wide reader. Guarded
 * against path traversal by looking the file up through `avatarAbsPath`, which
 * only ever returns a path inside the avatars pool.
 */
adminRouter.get("/users/:id/avatar", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid user id" });
    const user = await AppDataSource.getRepository(User).findOneBy({
      id: parsed.data.id,
    });
    if (!user || !user.avatarKey) return res.status(404).json({ error: "Not found" });
    const abs = avatarAbsPath(user.avatarKey);
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", mimeFromKey(user.avatarKey));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

/**
 * Hard-delete a user and everything account-scoped to them (memberships, API
 * keys, notifications, …), unlinking authored content so history survives. The
 * shared `deleteUserCascade` refuses when the user still owns a company —
 * surfaced here as a 409 with the offending company names so the operator knows
 * to reassign or delete those first. Deleting yourself is blocked: it would
 * invalidate the very session making the request.
 */
adminRouter.delete("/users/:id", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid user id" });
    const { id } = parsed.data;

    // Compare case-insensitively: zod's uuid() accepts an uppercased id, and on
    // Postgres a uuid comparison is case-insensitive, so a naive `===` could let
    // a caller slip past this guard and delete their own account.
    if (req.userId && id.toLowerCase() === req.userId.toLowerCase()) {
      return res.status(400).json({ error: "You can't delete your own account here." });
    }

    const user = await AppDataSource.getRepository(User).findOneBy({ id });
    if (!user) return res.status(404).json({ error: "Not found" });

    const result = await deleteUserCascade({ userId: id });

    // The avatar is a flat-pool file keyed off the row — best-effort cleanup.
    removeAvatarFile(user.avatarKey);

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UserOwnsCompaniesError) {
      return res.status(409).json({
        error: "This user owns one or more companies. Reassign or delete them first.",
        companies: err.companies,
      });
    }
    next(err);
  }
});

const masterAdminSchema = z.object({ isMasterAdmin: z.boolean() });

/**
 * Grant or revoke another user's master-admin status. Only master admins reach
 * this router at all, so the check that matters here is the self-guard: you
 * can't strip your own badge. Because no one can demote themselves, the install
 * can never be left with zero master admins — the acting operator always
 * survives their own PATCH.
 */
adminRouter.patch(
  "/users/:id/master-admin",
  validateBody(masterAdminSchema),
  async (req, res, next) => {
    try {
      const parsed = idParam.safeParse(req.params);
      if (!parsed.success) return res.status(400).json({ error: "Invalid user id" });
      const { id } = parsed.data;
      const { isMasterAdmin } = req.body as z.infer<typeof masterAdminSchema>;

      // Case-insensitive compare, same rationale as the delete guard: an
      // uppercased uuid must not slip past and let you demote yourself.
      if (!isMasterAdmin && req.userId && id.toLowerCase() === req.userId.toLowerCase()) {
        return res.status(400).json({ error: "You can't remove your own master admin access." });
      }

      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOneBy({ id });
      if (!user) return res.status(404).json({ error: "Not found" });
      if (isMasterAdmin && !user.emailVerifiedAt) {
        return res.status(409).json({
          error: "The account must verify its email before becoming a master admin.",
        });
      }
      if (user.isMasterAdmin !== isMasterAdmin) user.sessionVersion += 1;
      user.isMasterAdmin = isMasterAdmin;
      await repo.save(user);
      res.json({ id: user.id, isMasterAdmin: user.isMasterAdmin });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────── Companies ─────────────────────────────────

adminRouter.get("/companies", async (_req, res, next) => {
  try {
    res.json(await listAdminCompanies());
  } catch (err) {
    next(err);
  }
});

/**
 * Hard-delete a company and every row that hangs off it, then remove its
 * on-disk data directory. Reuses the same `deleteCompanyCascade` the
 * per-company "delete company" flow runs, so the blast radius is identical —
 * this route just lets an operator reach any company from one place instead of
 * having to switch into each one.
 */
adminRouter.delete("/companies/:id", async (req, res, next) => {
  try {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) return res.status(400).json({ error: "Invalid company id" });
    const co = await AppDataSource.getRepository(Company).findOneBy({
      id: parsed.data.id,
    });
    if (!co) return res.status(404).json({ error: "Not found" });
    await deleteCompanyCascade({ companyId: co.id, companySlug: co.slug });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
