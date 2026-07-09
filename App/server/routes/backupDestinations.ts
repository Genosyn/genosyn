import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireMasterAdmin } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  serializeDestination,
  testDestination,
  updateDestination,
  DestinationInput,
} from "../services/backupDestinations.js";

/**
 * Install-wide backup *destination* endpoints — where completed archives are
 * mirrored off-box (a mounted NAS path or an SFTP target). Not company-scoped,
 * matching the backups router: a backup spans every company's data, and these
 * rows hold SFTP credentials, so access is gated to master admins (the
 * instance-operator surface) exactly like the backups + admin routers.
 */
export const backupDestinationsRouter = Router();
backupDestinationsRouter.use(requireAuth);
backupDestinationsRouter.use(requireMasterAdmin);

const sftpAuthMode = z.enum(["password", "key"]);

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["local", "sftp"]),
    enabled: z.boolean().optional(),
    // local
    path: z.string().max(4096).optional(),
    // sftp
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(255).optional(),
    remoteDir: z.string().max(4096).optional(),
    authMode: sftpAuthMode.optional(),
    password: z.string().max(4096).optional(),
    privateKey: z.string().max(65536).optional(),
    passphrase: z.string().max(4096).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "local") {
      if (!val.path || !val.path.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A filesystem path is required for a local destination",
          path: ["path"],
        });
      }
      return;
    }
    // sftp
    const req = (field: keyof typeof val, label: string) => {
      const v = val[field];
      if (typeof v !== "string" || !v.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} is required for an SFTP destination`,
          path: [field],
        });
      }
    };
    req("host", "Host");
    req("username", "Username");
    req("remoteDir", "Remote directory");
    const mode = val.authMode ?? "password";
    if (mode === "password" && !val.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A password is required for password auth",
        path: ["password"],
      });
    }
    if (mode === "key" && !val.privateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A private key is required for key auth",
        path: ["privateKey"],
      });
    }
  });

// Update leaves `kind` fixed and every field optional — omitted secrets keep
// whatever is already stored (see buildConfig in the service).
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  path: z.string().max(4096).optional(),
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(255).optional(),
  remoteDir: z.string().max(4096).optional(),
  authMode: sftpAuthMode.optional(),
  password: z.string().max(4096).optional(),
  privateKey: z.string().max(65536).optional(),
  passphrase: z.string().max(4096).optional(),
});

backupDestinationsRouter.get("/", async (_req, res) => {
  const rows = await listDestinations();
  res.json(rows.map(serializeDestination));
});

backupDestinationsRouter.post(
  "/",
  validateBody(createSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createSchema>;
      const row = await createDestination(
        body as DestinationInput,
        req.userId ?? null,
      );
      res.json(serializeDestination(row));
    } catch (err) {
      next(err);
    }
  },
);

backupDestinationsRouter.put(
  "/:id",
  validateBody(updateSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateSchema>;
      const row = await updateDestination(req.params.id, body);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(serializeDestination(row));
    } catch (err) {
      next(err);
    }
  },
);

backupDestinationsRouter.delete("/:id", async (req, res) => {
  const ok = await deleteDestination(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

backupDestinationsRouter.post("/:id/test", async (req, res, next) => {
  try {
    const dest = await getDestination(req.params.id);
    if (!dest) return res.status(404).json({ error: "Not found" });
    const result = await testDestination(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
