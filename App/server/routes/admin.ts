import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { getInstanceHealthReport } from "../services/instanceHealth.js";
import { getMigrationReport } from "../services/adminMigrations.js";
import {
  AdminQueryError,
  getDbSchema,
  runAdminQuery,
} from "../services/adminDbConsole.js";
import {
  listAdminCompanies,
  listAdminUsers,
} from "../services/adminDirectory.js";
import {
  getSignupSettings,
  setSignupsDisabled,
} from "../services/signupSettings.js";
import {
  clearSsoSettings,
  describeSso,
  updateSsoSettings,
} from "../services/ssoSettings.js";
import { discoverOidcEndpoints, SsoLoginError } from "../services/ssoLogin.js";
import {
  deleteUserCascade,
  UserOwnsCompaniesError,
} from "../services/userDelete.js";
import { deleteCompanyCascade } from "../services/companyDelete.js";
import {
  avatarAbsPath,
  mimeFromKey,
  removeAvatarFile,
} from "../services/avatars.js";
import { sendGlobalSmtpTest } from "../services/email.js";
import {
  clearGlobalSmtpOverride,
  describeGlobalSmtp,
  resolveGlobalSmtpDraft,
  updateGlobalSmtpOverride,
} from "../services/globalEmailTransport.js";

/**
 * Instance-wide admin endpoints. Not company-scoped — these describe and manage
 * the whole deployment (health, the global email transport, and the directory
 * of every user + company on it) rather than a single company's data.
 *
 * Auth is `requireAuth` + `requireMasterAdmin`: the Admin section is the
 * operator surface, gated to users carrying the instance-level `isMasterAdmin`
 * flag. The first account created on an install is bootstrapped as a master
 * admin; existing master admins promote others from `PATCH /users/:id/master-admin`
 * below. The destructive routes here (delete user / delete company) and the
 * companion backup-restore route are all held to the same master-admin bar.
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
    return res
      .status(400)
      .json({ error: err instanceof Error ? err.message : String(err) });
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

adminRouter.put(
  "/email-transport",
  validateBody(saveSchema),
  async (req, res, next) => {
    const body = req.body as z.infer<typeof saveSchema>;
    // The write is the only fallible-by-user step: a bad payload returns 400.
    try {
      await updateGlobalSmtpOverride(body);
    } catch (err) {
      return res.status(400).json({
        error:
          err instanceof Error ? err.message : "Failed to save email transport",
      });
    }
    // The save already succeeded — a failure re-reading state to build the
    // response is a server error (500 via next), not a "save failed" 400.
    try {
      res.json(await describeGlobalSmtp());
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete("/email-transport", async (_req, res, next) => {
  try {
    await clearGlobalSmtpOverride();
    res.json(await describeGlobalSmtp());
  } catch (err) {
    next(err);
  }
});

const testSchema = z.object({ ...smtpFields, to: z.string().email() });

adminRouter.post(
  "/email-transport/test",
  validateBody(testSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof testSchema>;
    try {
      const settings = await resolveGlobalSmtpDraft(body);
      if (!settings.host) {
        return res
          .status(400)
          .json({ ok: false, error: "SMTP host is required" });
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
        res
          .status(400)
          .json({ ok: false, error: result.errorMessage, logId: result.logId });
      }
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
// signup endpoint refuses everyone but the first-user bootstrap; existing
// members and invited users are unaffected.

adminRouter.get("/signup-settings", async (_req, res, next) => {
  try {
    res.json(await getSignupSettings());
  } catch (err) {
    next(err);
  }
});

const signupSettingsSchema = z.object({ signupsDisabled: z.boolean() });

adminRouter.put(
  "/signup-settings",
  validateBody(signupSettingsSchema),
  async (req, res, next) => {
    try {
      const { signupsDisabled } = req.body as z.infer<
        typeof signupSettingsSchema
      >;
      res.json(await setSignupsDisabled(signupsDisabled));
    } catch (err) {
      next(err);
    }
  },
);

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

const ssoTestSchema = z.object({ issuer: z.string().min(1).max(500) });

/**
 * Probe an issuer's OIDC discovery document before the operator commits to
 * it — reports the endpoints found, or the reason the issuer can't be used.
 * No credentials are involved, so this is safe to run against a draft.
 */
adminRouter.post(
  "/sso/test",
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
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid user id" });
    const user = await AppDataSource.getRepository(User).findOneBy({
      id: parsed.data.id,
    });
    if (!user || !user.avatarKey)
      return res.status(404).json({ error: "Not found" });
    const abs = avatarAbsPath(user.avatarKey);
    if (!abs || !fs.existsSync(abs))
      return res.status(404).json({ error: "Not found" });
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
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid user id" });
    const { id } = parsed.data;

    // Compare case-insensitively: zod's uuid() accepts an uppercased id, and on
    // Postgres a uuid comparison is case-insensitive, so a naive `===` could let
    // a caller slip past this guard and delete their own account.
    if (req.userId && id.toLowerCase() === req.userId.toLowerCase()) {
      return res
        .status(400)
        .json({ error: "You can't delete your own account here." });
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
        error:
          "This user owns one or more companies. Reassign or delete them first.",
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
      if (!parsed.success)
        return res.status(400).json({ error: "Invalid user id" });
      const { id } = parsed.data;
      const { isMasterAdmin } = req.body as z.infer<typeof masterAdminSchema>;

      // Case-insensitive compare, same rationale as the delete guard: an
      // uppercased uuid must not slip past and let you demote yourself.
      if (
        !isMasterAdmin &&
        req.userId &&
        id.toLowerCase() === req.userId.toLowerCase()
      ) {
        return res
          .status(400)
          .json({ error: "You can't remove your own master admin access." });
      }

      const repo = AppDataSource.getRepository(User);
      const user = await repo.findOneBy({ id });
      if (!user) return res.status(404).json({ error: "Not found" });
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
    if (!parsed.success)
      return res.status(400).json({ error: "Invalid company id" });
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
