import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";
import { getMigrationReport } from "../services/adminMigrations.js";
import { AdminQueryError, getDbSchema, runAdminQuery } from "../services/adminDbConsole.js";
import { listAdminCompanies, listAdminUsers } from "../services/adminDirectory.js";
import { getSignupSettings, setSignupsDisabled } from "../services/signupSettings.js";
import {
  clearSsoSettings,
  describeSso,
  setCompanySsoAllowed,
  updateSsoSettings,
} from "../services/ssoSettings.js";
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
  CustomJavaScriptValidationError,
  getCustomJavaScriptSettings,
  MAX_CUSTOM_JAVASCRIPT_LENGTH,
  setCustomJavaScript,
} from "../services/customJavaScript.js";
import {
  getRuntimeSettingsSnapshot,
  normalizeOauthSettingNames,
  normalizeSignInUrl,
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
  registeredOauthApps,
  saveOauthApp,
} from "../services/oauthApps.js";
import { describeHostedSignIn } from "../services/hostedOauth.js";

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

adminRouter.get("/custom-javascript", async (_req, res, next) => {
  try {
    res.json(await getCustomJavaScriptSettings());
  } catch (err) {
    next(err);
  }
});

const customJavaScriptSchema = z.object({
  customJavaScript: z.string().max(MAX_CUSTOM_JAVASCRIPT_LENGTH),
});

adminRouter.put(
  "/custom-javascript",
  validateBody(customJavaScriptSchema),
  async (req, res, next) => {
    try {
      const { customJavaScript } = req.body as z.infer<typeof customJavaScriptSchema>;
      res.json(await setCustomJavaScript(customJavaScript));
    } catch (err) {
      if (err instanceof CustomJavaScriptValidationError) {
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
  group: z.enum(["web", "mail", "oauth", "meetings", "browser", "agent", "containment", "network"]),
});

const runtimeGroupSchemas = {
  web: z.object({
    enabled: z.boolean(),
    searchProvider: z.enum(["duckduckgo", "searxng", "disabled"]),
    searxngUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => value === "" || /^https?:\/\/[^/\s]+/i.test(value), {
        message: "Use an http(s) URL such as http://searxng:8080",
      })
      .default(""),
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
  oauth: z.preprocess(
    normalizeOauthSettingNames,
    z.object({
      hostedSignInEnabled: z.boolean(),
      hostedSignInUrl: z
        .string()
        .trim()
        .max(2048)
        .refine(
          (value) => normalizeSignInUrl(value) !== null,
          "Use an HTTPS origin without credentials, a path, query, or fragment. HTTP is allowed only on localhost for development.",
        ),
    }).strict(),
  ),
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
    maxConcurrentTurnsPerCompany: z.number().int().min(1).max(100).default(8),
    taintPolicy: z.enum(["web", "off"]),
    memberBrowsersEnabled: z.boolean(),
    toolDiscovery: z.object({
      enabled: z.boolean(),
      minCatalogueSize: z.number().int().min(0).max(10_000),
    }),
  }),
  containment: z.object({
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

// Whether Genosyn Connect is reachable from here and what it offers, so an
// admin can tell "turned off", "cannot reach it" and "does not offer Gmail"
// apart without reading server logs. No secret is involved: the service's
// status routes are public.
adminRouter.get("/hosted-sign-in", validateQuery(z.object({}).strict()), async (_req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await describeHostedSignIn(await registeredOauthApps()));
  } catch (err) {
    next(err);
  }
});

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

const companySsoAllowedSchema = z.object({ allowed: z.boolean() });

// Whether companies may sign Members in through their own identity provider.
// Kept apart from the instance form so resetting instance SSO leaves it alone.
adminRouter.put(
  "/sso/company",
  validateBody(companySsoAllowedSchema),
  async (req, res, next) => {
    const { allowed } = req.body as z.infer<typeof companySsoAllowedSchema>;
    try {
      await setCompanySsoAllowed(allowed);
      res.json(await describeSso());
    } catch (err) {
      next(err);
    }
  },
);

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
