import type { RequestListener } from "node:http";
import type { TLSSocket } from "node:tls";
import { Router, type Request } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { requireAuth, requireCompanyMember, usesBearerCredential } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { FORWARDED_HEADERS } from "../services/companyMcp/context.js";
import { applyEmployeeAccessBulk, type ReplayContext } from "../services/employeeAccess/bulk.js";
import { listEmployeeAccess } from "../services/employeeAccess/listing.js";
import { accessViewerFrom } from "../services/employeeAccess/rules.js";
import {
  ACCESS_BULK_ACTIONS,
  ACCESS_BULK_MAX_ITEMS,
  ACCESS_KINDS,
  ACCESS_KIND_META,
  accessLevelValues,
  type AccessKind,
} from "../../shared/employeeAccess.js";

/**
 * One AI Employee's Access page: everything the company has that can be
 * granted, what this employee holds of it, and many changes at once.
 * Mounted at `/api/companies/:cid/employees`, beside the employee's own routes.
 *
 * Open to every Member, like the sections' own AI access pages: anyone can see
 * what has been delegated. Who may change what is not decided here — each
 * change in a bulk request is replayed through its kind's own route
 * (`services/employeeAccess/bulk.ts`), so a Member who may not grant a mailbox
 * on the mailbox's page may not grant it here either, and a Member browser is
 * still granted only by the Member who connected it.
 *
 * There is deliberately no MCP tool behind either route: an AI Employee must
 * never be able to grant itself, or a teammate, access to anything.
 */
export const employeeAccessRouter = Router({ mergeParams: true });
employeeAccessRouter.use(requireAuth);
employeeAccessRouter.use(requireCompanyMember);

export const employeeAccessParamsSchema = z
  .object({ cid: z.string().uuid(), eid: z.string().uuid() })
  .strict();

export const employeeAccessListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Words every listed row's name or second line must contain."),
  })
  .strict();

/** One row to change. Its `level` takes only the levels its own kind has. */
function itemSchema(kind: AccessKind) {
  const meta = ACCESS_KIND_META[kind];
  const levels = accessLevelValues(kind);
  const shape: Record<string, z.ZodTypeAny> = { kind: z.literal(kind) };
  if (meta.scope === "resource") shape.resourceId = z.string().uuid();
  if (levels.length) shape.level = z.enum(levels as [string, ...string[]]).optional();
  return z.object(shape).strict();
}

const itemSchemas = ACCESS_KINDS.map((kind) => itemSchema(kind)) as unknown as [
  z.ZodDiscriminatedUnionOption<"kind">,
  ...z.ZodDiscriminatedUnionOption<"kind">[],
];

export const employeeAccessBulkSchema = z
  .object({
    action: z
      .enum(ACCESS_BULK_ACTIONS)
      .describe(
        "`grant` adds a Grant where there is none, `set_level` moves an existing one, `revoke` takes it away.",
      ),
    items: z.array(z.discriminatedUnion("kind", itemSchemas)).min(1).max(ACCESS_BULK_MAX_ITEMS),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action !== "set_level") return;
    body.items.forEach((item, index) => {
      const entry = item as { kind: AccessKind; level?: string };
      if (accessLevelValues(entry.kind).length && !entry.level) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "level"],
          message: "Changing a level needs the level to change it to.",
        });
      }
    });
  });

async function loadEmployee(companyId: string, employeeId: string): Promise<AIEmployee | null> {
  return AppDataSource.getRepository(AIEmployee).findOne({
    where: { id: employeeId, companyId },
    select: { id: true, name: true, slug: true, companyId: true },
  });
}

/**
 * How each replayed change authenticates: with the credential this request
 * came with — its session cookie, or its API key, never both — from the same
 * address, so every guard sees exactly the caller it would have seen.
 */
function replayContext(req: Request): ReplayContext {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) headers[name] = value;
    else if (Array.isArray(value) && value.length) headers[name] = value.join(", ");
  }
  // A connected app's token is a credential on in-process requests, which
  // these are, exactly as on the Genosyn MCP server call that brought it here.
  if (usesBearerCredential(req)) headers.authorization = req.headers.authorization ?? "";
  else if (req.headers.cookie) headers.cookie = req.headers.cookie;
  const socket = req.socket as Partial<TLSSocket>;
  return {
    app: req.app as unknown as RequestListener,
    headers,
    remote: {
      address: socket.remoteAddress,
      port: socket.remotePort,
      family: socket.remoteFamily,
      encrypted: Boolean(socket.encrypted),
    },
  };
}

employeeAccessRouter.get(
  "/:eid/access",
  validateParams(employeeAccessParamsSchema),
  validateQuery(employeeAccessListQuerySchema),
  async (req, res, next) => {
    try {
      const { cid, eid } = req.params as z.infer<typeof employeeAccessParamsSchema>;
      const query = req.query as z.infer<typeof employeeAccessListQuerySchema>;
      const employee = await loadEmployee(cid, eid);
      if (!employee) return res.status(404).json({ error: "Employee not found" });
      res.json(
        await listEmployeeAccess({
          companyId: cid,
          employee,
          viewer: accessViewerFrom(req),
          query: query.q,
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

employeeAccessRouter.post(
  "/:eid/access/bulk",
  validateParams(employeeAccessParamsSchema),
  validateBody(employeeAccessBulkSchema),
  async (req, res, next) => {
    try {
      const { cid, eid } = req.params as z.infer<typeof employeeAccessParamsSchema>;
      const body = req.body as z.infer<typeof employeeAccessBulkSchema>;
      const employee = await loadEmployee(cid, eid);
      if (!employee) return res.status(404).json({ error: "Employee not found" });
      res.json(
        await applyEmployeeAccessBulk({
          companyId: cid,
          employee,
          viewer: accessViewerFrom(req),
          action: body.action,
          items: body.items as Array<{ kind: AccessKind; resourceId?: string; level?: string }>,
          replay: replayContext(req),
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);
