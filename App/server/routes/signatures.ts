import fs from "node:fs";
import path from "node:path";

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import multer from "multer";
import { In } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { SIGNING_ACCESS_LEVELS } from "../db/entities/EmployeeSigningGrant.js";
import { SIGNATURE_ENVELOPE_STATUSES } from "../db/entities/SignatureEnvelope.js";
import { SIGNATURE_FIELD_TYPES } from "../db/entities/SignatureField.js";
import { SIGNATURE_RECIPIENT_ROLES } from "../db/entities/SignatureRecipient.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  SigningConflictError,
  SigningNotFoundError,
  SigningValidationError,
  createSignatureEnvelopeFromUpload,
  deleteSignatureEnvelope,
  deleteSigningGrant,
  duplicateSignatureEnvelope,
  getSignatureEnvelopeDetail,
  listSignatureEnvelopes,
  listSigningGrants,
  remindSignatureRecipient,
  resolveSignatureDocument,
  sendSignatureEnvelope,
  signingUploadMiddleware,
  updateSignatureEnvelopeDraft,
  upsertSigningGrant,
  voidSignatureEnvelope,
  type SignatureEnvelopeDetail,
} from "../services/signing.js";

/**
 * Member-facing HTTP boundary for signature envelopes. Business rules and
 * evidence creation live in services/signing.ts; this module authenticates,
 * validates, safely handles multipart bytes, and shapes transport responses.
 * Mounted at `/api/companies/:cid`.
 */
export const signaturesRouter = Router({ mergeParams: true });

signaturesRouter.use(requireAuth);
signaturesRouter.use(requireCompanyMember);
signaturesRouter.use(
  onRoutePaths(["/signatures/ai-access"], requireCompanyRoleForMutations("admin")),
);

const uuid = z.string().uuid();
const companyParamsSchema = z.object({ cid: uuid }).strict();
const envelopeParamsSchema = z.object({ cid: uuid, envelopeId: uuid }).strict();
const recipientParamsSchema = z.object({ cid: uuid, envelopeId: uuid, recipientId: uuid }).strict();
const employeeParamsSchema = z.object({ cid: uuid, employeeId: uuid }).strict();

const optionalExpirationSchema = z
  .union([
    z
      .string()
      .trim()
      .max(40)
      .refine((value) => Number.isFinite(new Date(value).getTime()), {
        message: "Expiration must be a valid date",
      }),
    z.literal(""),
    z.null(),
  ])
  .optional();

const recipientSchema = z
  .object({
    id: uuid.optional(),
    key: z.string().trim().min(1).max(255).optional(),
    role: z.enum(SIGNATURE_RECIPIENT_ROLES as [string, ...string[]]),
    // Drafts persist while a Member is still typing. Send-time validation is
    // deliberately stricter and supplies actionable readiness errors.
    name: z.string().trim().max(255),
    email: z.string().trim().max(320),
    routingOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const fieldSchema = z
  .object({
    id: uuid.optional(),
    recipientId: uuid.optional(),
    recipientKey: z.string().trim().min(1).max(255).optional(),
    type: z.enum(SIGNATURE_FIELD_TYPES as [string, ...string[]]),
    label: z.string().trim().max(255).optional(),
    placeholder: z.string().trim().max(255).optional(),
    required: z.boolean().optional(),
    pageNumber: z.number().int().min(1).max(100_000),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().gt(0).max(1),
    height: z.number().finite().gt(0).max(1),
    sortOrder: z.number().finite().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((field) => Boolean(field.recipientId) !== Boolean(field.recipientKey), {
    message: "Each field needs either recipientId or recipientKey",
  })
  .refine((field) => field.x + field.width <= 1 && field.y + field.height <= 1, {
    message: "Field geometry must fit inside the page",
  });

const createMultipartSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    customerId: z.union([uuid, z.literal("")]).optional(),
    message: z.string().trim().max(10_000).optional(),
    routingMode: z.enum(["parallel", "ordered"]).optional(),
    expiresAt: optionalExpirationSchema,
  })
  .strict();

const draftPatchSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
    title: z.string().trim().min(1).max(255).optional(),
    message: z.string().trim().max(10_000).optional(),
    customerId: uuid.nullable().optional(),
    routingMode: z.enum(["parallel", "ordered"]).optional(),
    expiresAt: optionalExpirationSchema,
    recipients: z.array(recipientSchema).max(200).optional(),
    fields: z.array(fieldSchema).max(2_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one draft field is required",
  })
  .refine((body) => body.fields === undefined || body.recipients !== undefined, {
    message: "Recipients are required when replacing fields",
  });

const sendBodySchema = z
  .object({
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const listQuerySchema = z
  .object({
    status: z.enum(SIGNATURE_ENVELOPE_STATUSES as [string, ...string[]]).optional(),
    customerId: uuid.optional(),
    q: z.string().trim().max(255).optional(),
  })
  .strict();

const duplicateBodySchema = z
  .object({ title: z.string().trim().min(1).max(255).optional() })
  .strict()
  .default({});
const emptyBodySchema = z.object({}).strict().default({});
const voidBodySchema = z
  .object({ reason: z.string().trim().max(2_000).optional().default("") })
  .strict();
const grantBodySchema = z
  .object({
    accessLevel: z.enum(SIGNING_ACCESS_LEVELS as [string, ...string[]]),
  })
  .strict();

type CustomerStub = { id: string; name: string; slug: string } | null;

function companyId(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function userActor(req: Request): { userId: string } {
  if (!req.userId) throw new SigningValidationError("Authenticated Member is required");
  return { userId: req.userId };
}

function route(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch((error: unknown) => {
      if (error instanceof SigningValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof SigningNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof SigningConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

async function companyFor(req: Request): Promise<Company> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId(req) });
  if (!company) throw new SigningNotFoundError("Company not found");
  return company;
}

async function customerStubs(
  cid: string,
  ids: Array<string | null>,
): Promise<Map<string, Exclude<CustomerStub, null>>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId: cid, id: In(unique) },
  });
  return new Map(
    customers.map((customer) => [
      customer.id,
      { id: customer.id, name: customer.name, slug: customer.slug },
    ]),
  );
}

function serializeEnvelope(envelope: SignatureEnvelopeDetail["envelope"]): Record<string, unknown> {
  const {
    originalStorageKey: _originalStorageKey,
    completedStorageKey: _completedStorageKey,
    documentText: _documentText,
    ...safe
  } = envelope;
  return {
    ...safe,
    originalSizeBytes: Number(envelope.originalSizeBytes),
    completedSizeBytes: Number(envelope.completedSizeBytes),
  };
}

function serializeRecipient(
  recipient: SignatureEnvelopeDetail["recipients"][number],
): Record<string, unknown> {
  const { tokenHash: _tokenHash, ...safe } = recipient;
  return safe;
}

function serializeDetail(detail: SignatureEnvelopeDetail, customer: CustomerStub) {
  return {
    envelope: serializeEnvelope(detail.envelope),
    recipients: detail.recipients.map(serializeRecipient),
    fields: detail.fields.map(({ valueJson: _valueJson, ...field }) => field),
    events: detail.events.map(({ metadataJson: _metadataJson, ...event }) => event),
    customer,
  };
}

async function detailResponse(detail: SignatureEnvelopeDetail) {
  const customers = await customerStubs(detail.envelope.companyId, [detail.envelope.customerId]);
  return serializeDetail(
    detail,
    detail.envelope.customerId ? (customers.get(detail.envelope.customerId) ?? null) : null,
  );
}

async function cleanupUpload(req: Request): Promise<void> {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (file?.path) await fs.promises.unlink(file.path).catch(() => undefined);
}

const acceptSigningUpload: RequestHandler = (req, res, next) => {
  signingUploadMiddleware(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    void cleanupUpload(req).finally(() => {
      if (error instanceof multer.MulterError) {
        const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({
          error:
            error.code === "LIMIT_FILE_SIZE"
              ? "The PDF must be 25 MB or smaller"
              : "The PDF upload is invalid",
        });
        return;
      }
      if (error instanceof SigningValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    });
  });
};

function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const utf8 =
    path
      .basename(filename)
      .replace(/[\r\n]/g, "_")
      .slice(0, 255) || "document.pdf";
  const ascii = utf8.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

signaturesRouter.get(
  "/signature-envelopes",
  validateParams(companyParamsSchema),
  route(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid signature envelope filters", issues: parsed.error.issues });
      return;
    }
    const rows = await listSignatureEnvelopes({ companyId: companyId(req), ...parsed.data });
    const customers = await customerStubs(
      companyId(req),
      rows.map((row) => row.customerId),
    );
    res.json(
      rows.map((row) => ({
        ...serializeEnvelope(row),
        recipientCount: row.recipientCount,
        completedRecipientCount: row.completedRecipientCount,
        customer: row.customerId ? (customers.get(row.customerId) ?? null) : null,
      })),
    );
  }),
);

signaturesRouter.post(
  "/signature-envelopes",
  validateParams(companyParamsSchema),
  acceptSigningUpload,
  route(async (req, res) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "Choose a PDF to sign" });
      return;
    }
    try {
      const parsed = createMultipartSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid envelope fields", issues: parsed.error.issues });
        return;
      }
      const body = parsed.data;
      const detail = await createSignatureEnvelopeFromUpload({
        company: await companyFor(req),
        file,
        title: body.title,
        message: body.message,
        customerId: body.customerId || null,
        routingMode: body.routingMode,
        expiresAt: body.expiresAt || null,
        actor: userActor(req),
      });
      res.status(201).json(await detailResponse(detail));
    } finally {
      await cleanupUpload(req);
    }
  }),
);

signaturesRouter.get(
  "/signature-envelopes/:envelopeId",
  validateParams(envelopeParamsSchema),
  route(async (req, res) => {
    const detail = await getSignatureEnvelopeDetail({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
    });
    res.json(await detailResponse(detail));
  }),
);

signaturesRouter.patch(
  "/signature-envelopes/:envelopeId",
  validateParams(envelopeParamsSchema),
  validateBody(draftPatchSchema),
  route(async (req, res) => {
    const detail = await updateSignatureEnvelopeDraft({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
      ...req.body,
      ...(req.body.expiresAt !== undefined ? { expiresAt: req.body.expiresAt || null } : {}),
      actor: userActor(req),
    });
    res.json(await detailResponse(detail));
  }),
);

signaturesRouter.delete(
  "/signature-envelopes/:envelopeId",
  validateParams(envelopeParamsSchema),
  route(async (req, res) => {
    await deleteSignatureEnvelope({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
    });
    res.status(204).end();
  }),
);

signaturesRouter.post(
  "/signature-envelopes/:envelopeId/duplicate",
  validateParams(envelopeParamsSchema),
  validateBody(duplicateBodySchema),
  route(async (req, res) => {
    const detail = await duplicateSignatureEnvelope({
      company: await companyFor(req),
      envelopeId: req.params.envelopeId,
      title: req.body.title,
      actor: userActor(req),
    });
    res.status(201).json(await detailResponse(detail));
  }),
);

signaturesRouter.post(
  "/signature-envelopes/:envelopeId/send",
  validateParams(envelopeParamsSchema),
  validateBody(sendBodySchema),
  route(async (req, res) => {
    const detail = await sendSignatureEnvelope({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
      expectedUpdatedAt: req.body.expectedUpdatedAt,
      actor: userActor(req),
    });
    res.json(await detailResponse(detail));
  }),
);

signaturesRouter.post(
  "/signature-envelopes/:envelopeId/recipients/:recipientId/remind",
  validateParams(recipientParamsSchema),
  validateBody(emptyBodySchema),
  route(async (req, res) => {
    const detail = await remindSignatureRecipient({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
      recipientId: req.params.recipientId,
      actor: userActor(req),
    });
    res.json(await detailResponse(detail));
  }),
);

signaturesRouter.post(
  "/signature-envelopes/:envelopeId/void",
  validateParams(envelopeParamsSchema),
  validateBody(voidBodySchema),
  route(async (req, res) => {
    const detail = await voidSignatureEnvelope({
      companyId: companyId(req),
      envelopeId: req.params.envelopeId,
      reason: req.body.reason,
      actor: userActor(req),
    });
    res.json(await detailResponse(detail));
  }),
);

async function sendDocument(
  req: Request,
  res: Response,
  variant: "original" | "completed",
): Promise<void> {
  const document = await resolveSignatureDocument({
    companyId: companyId(req),
    envelopeId: req.params.envelopeId,
    variant,
    actor: userActor(req),
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.get("user-agent"),
  });
  res.setHeader("Content-Type", document.mimeType);
  res.setHeader("Content-Length", String(document.sizeBytes));
  res.setHeader(
    "Content-Disposition",
    contentDisposition(document.filename, variant === "original" ? "inline" : "attachment"),
  );
  res.setHeader("ETag", `"sha256-${document.sha256}"`);
  res.sendFile(document.path);
}

for (const sourcePath of [
  "/signature-envelopes/:envelopeId/source",
  "/signature-envelopes/:envelopeId/original",
]) {
  signaturesRouter.get(
    sourcePath,
    validateParams(envelopeParamsSchema),
    route(async (req, res) => sendDocument(req, res, "original")),
  );
}

signaturesRouter.get(
  "/signature-envelopes/:envelopeId/completed",
  validateParams(envelopeParamsSchema),
  route(async (req, res) => sendDocument(req, res, "completed")),
);

signaturesRouter.get(
  "/signatures/ai-access",
  validateParams(companyParamsSchema),
  route(async (req, res) => {
    const cid = companyId(req);
    const [employees, grants] = await Promise.all([
      AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: cid },
        order: { name: "ASC" },
      }),
      listSigningGrants({ companyId: cid }),
    ]);
    const byEmployee = new Map(grants.map((grant) => [grant.employeeId, grant]));
    res.json(
      employees.map((employee) => ({
        employee: {
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          role: employee.role,
          avatarKey: employee.avatarKey,
        },
        grant: byEmployee.get(employee.id) ?? null,
      })),
    );
  }),
);

signaturesRouter.put(
  "/signatures/ai-access/:employeeId",
  validateParams(employeeParamsSchema),
  validateBody(grantBodySchema),
  route(async (req, res) => {
    res.json(
      await upsertSigningGrant({
        companyId: companyId(req),
        employeeId: req.params.employeeId,
        accessLevel: req.body.accessLevel,
      }),
    );
  }),
);

signaturesRouter.delete(
  "/signatures/ai-access/:employeeId",
  validateParams(employeeParamsSchema),
  route(async (req, res) => {
    if (
      !(await deleteSigningGrant({
        companyId: companyId(req),
        employeeId: req.params.employeeId,
      }))
    ) {
      res.status(404).json({ error: "Signing Grant not found" });
      return;
    }
    res.status(204).end();
  }),
);
