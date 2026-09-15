import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  BaseFormRequestError,
  baseFormQuestionsSchema,
  createBaseForm,
  deleteBaseForm,
  getBaseForm,
  listBaseForms,
  rotateBaseFormLink,
  updateBaseForm,
} from "../services/baseForms.js";

export const formsRouter = Router({ mergeParams: true });
formsRouter.use(requireAuth);
formsRouter.use(requireCompanyMember);

const collectionParamsSchema = z
  .object({
    cid: z.string().uuid(),
    baseSlug: z.string().min(1).max(120),
    tableId: z.string().uuid(),
  })
  .strict();

const formParamsSchema = collectionParamsSchema
  .extend({ formSlug: z.string().min(1).max(120) })
  .strict();

const createFormSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
  })
  .strict();

const patchFormSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(5_000).optional(),
    submitLabel: z.string().trim().min(1).max(80).optional(),
    successTitle: z.string().trim().min(1).max(160).optional(),
    successMessage: z.string().max(5_000).optional(),
    allowAnotherResponse: z.boolean().optional(),
    published: z.boolean().optional(),
    acceptingResponses: z.boolean().optional(),
    questions: baseFormQuestionsSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "At least one change is required" });

function memberRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next: NextFunction) => {
    void handler(req, res).catch((error: unknown) => {
      if (error instanceof BaseFormRequestError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

const collectionPath = "/bases/:baseSlug/tables/:tableId/forms";
const formPath = `${collectionPath}/:formSlug`;

formsRouter.get(
  collectionPath,
  validateParams(collectionParamsSchema),
  memberRoute(async (req, res) => {
    res.json(
      await listBaseForms({
        companyId: req.params.cid,
        baseSlug: req.params.baseSlug,
        tableId: req.params.tableId,
      }),
    );
  }),
);

formsRouter.post(
  collectionPath,
  validateParams(collectionParamsSchema),
  validateBody(createFormSchema),
  memberRoute(async (req, res) => {
    const body = req.body as z.infer<typeof createFormSchema>;
    const detail = await createBaseForm({
      companyId: req.params.cid,
      baseSlug: req.params.baseSlug,
      tableId: req.params.tableId,
      title: body.title,
      actorUserId: req.userId ?? null,
    });
    res.status(201).json(detail);
  }),
);

formsRouter.get(
  formPath,
  validateParams(formParamsSchema),
  memberRoute(async (req, res) => {
    res.json(
      await getBaseForm({
        companyId: req.params.cid,
        baseSlug: req.params.baseSlug,
        tableId: req.params.tableId,
        formSlug: req.params.formSlug,
      }),
    );
  }),
);

formsRouter.patch(
  formPath,
  validateParams(formParamsSchema),
  validateBody(patchFormSchema),
  memberRoute(async (req, res) => {
    res.json(
      await updateBaseForm({
        companyId: req.params.cid,
        baseSlug: req.params.baseSlug,
        tableId: req.params.tableId,
        formSlug: req.params.formSlug,
        patch: req.body as z.infer<typeof patchFormSchema>,
        actorUserId: req.userId ?? null,
      }),
    );
  }),
);

formsRouter.delete(
  formPath,
  validateParams(formParamsSchema),
  memberRoute(async (req, res) => {
    await deleteBaseForm({
      companyId: req.params.cid,
      baseSlug: req.params.baseSlug,
      tableId: req.params.tableId,
      formSlug: req.params.formSlug,
      actorUserId: req.userId ?? null,
    });
    res.json({ ok: true });
  }),
);

formsRouter.post(
  `${formPath}/rotate-link`,
  validateParams(formParamsSchema),
  validateBody(z.object({}).strict().default({})),
  memberRoute(async (req, res) => {
    res.json(
      await rotateBaseFormLink({
        companyId: req.params.cid,
        baseSlug: req.params.baseSlug,
        tableId: req.params.tableId,
        formSlug: req.params.formSlug,
        actorUserId: req.userId ?? null,
      }),
    );
  }),
);
