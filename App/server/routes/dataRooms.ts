import fs from "node:fs";

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import multer from "multer";
import { z } from "zod";

import {
  DATA_ROOM_ACCESS_LEVELS,
  DATA_ROOM_AI_ANSWER_MODES,
  DATA_ROOM_LIMITS,
  DATA_ROOM_PURPOSES,
  DATA_ROOM_QUESTION_STATUSES,
  DATA_ROOM_STATUSES,
} from "../../shared/dataRooms.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { type DataRoomActor, requireRoom } from "../services/dataRooms/access.js";
import { roomActivity } from "../services/dataRooms/activity.js";
import {
  addDocumentFromResource,
  addDocumentFromUpload,
  deleteDocument,
  documentFile,
  readDocumentText,
  requestBrief,
  requireDocument,
  updateDocument,
} from "../services/dataRooms/documents.js";
import { DataRoomValidationError, isDataRoomError } from "../services/dataRooms/errors.js";
import {
  deleteDataRoomGrant,
  listDataRoomGrants,
  upsertDataRoomGrant,
} from "../services/dataRooms/grants.js";
import {
  guestLinkFor,
  inviteGuest,
  listGuests,
  reissueGuestLink,
  resendInvitation,
  setGuestStatus,
  updateGuest,
} from "../services/dataRooms/guests.js";
import {
  answerQuestion,
  publishDraft,
  requestDraft,
  requestRoomReview,
  setQuestionStatus,
} from "../services/dataRooms/questions.js";
import {
  createDataRoom,
  createFolder,
  deleteDataRoom,
  deleteFolder,
  listFolders,
  renameFolder,
  reorderFolders,
  requestMissingBriefs,
  updateDataRoom,
} from "../services/dataRooms/rooms.js";
import {
  questionView,
  questionsView,
  roomDetailView,
  roomListView,
  serializeDocument,
  serializeFolder,
  serializeGuest,
} from "../services/dataRooms/serialize.js";
import { contentDisposition, dataRoomUploadMiddleware } from "../services/dataRooms/storage.js";

/**
 * The company's side of data rooms. Mounted at `/api/companies/:cid`.
 *
 * Owners and admins only, reads included: a room holds the company's most
 * sensitive documents and often news the rest of the company has not heard —
 * a raise, a sale — so Members never see one. Guests reach their rooms through
 * `publicDataRooms.ts`, with their link as the only credential. Business rules
 * live in `services/dataRooms/`; this module authenticates, validates, handles
 * the multipart bytes and shapes responses.
 */
export const dataRoomsRouter = Router({ mergeParams: true });

dataRoomsRouter.use(requireAuth);
dataRoomsRouter.use(requireCompanyMember);
dataRoomsRouter.use(onRoutePaths(["/data-rooms"], requireCompanyRole("admin")));

const uuid = z.string().uuid();
const companyParams = z.object({ cid: uuid }).strict();
const roomParams = z.object({ cid: uuid, roomId: uuid }).strict();
const folderParams = z.object({ cid: uuid, roomId: uuid, folderId: uuid }).strict();
const documentParams = z.object({ cid: uuid, roomId: uuid, documentId: uuid }).strict();
const guestParams = z.object({ cid: uuid, roomId: uuid, guestId: uuid }).strict();
const questionParams = z.object({ cid: uuid, roomId: uuid, questionId: uuid }).strict();
const employeeParams = z.object({ cid: uuid, employeeId: uuid }).strict();
const emptyBody = z.object({}).strict().default({});

/** An ISO datetime with an offset; the services check it is in the future. */
const isoDateTime = z.string().datetime({ offset: true });

function dateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

const citation = z
  .object({
    documentId: uuid,
    quote: z.string().trim().min(1).max(DATA_ROOM_LIMITS.quoteChars),
  })
  .strict();

const createRoomBody = z
  .object({
    name: z.string().trim().min(1).max(DATA_ROOM_LIMITS.nameChars),
    purpose: z.enum(DATA_ROOM_PURPOSES),
    description: z.string().max(DATA_ROOM_LIMITS.descriptionChars).optional(),
    welcomeMessage: z.string().max(DATA_ROOM_LIMITS.welcomeChars).optional(),
    aiEmployeeId: uuid.nullable().optional(),
    seedFolders: z.boolean().optional(),
  })
  .strict();

const updateRoomBody = z
  .object({
    name: z.string().trim().min(1).max(DATA_ROOM_LIMITS.nameChars).optional(),
    purpose: z.enum(DATA_ROOM_PURPOSES).optional(),
    description: z.string().max(DATA_ROOM_LIMITS.descriptionChars).optional(),
    welcomeMessage: z.string().max(DATA_ROOM_LIMITS.welcomeChars).optional(),
    allowDownloads: z.boolean().optional(),
    watermark: z.boolean().optional(),
    requireTerms: z.boolean().optional(),
    termsText: z.string().max(DATA_ROOM_LIMITS.termsChars).optional(),
    aiEmployeeId: uuid.nullable().optional(),
    aiAnswerMode: z.enum(DATA_ROOM_AI_ANSWER_MODES).optional(),
    status: z.enum(DATA_ROOM_STATUSES).optional(),
  })
  .strict();

const listRoomsQuery = z.object({ status: z.enum(DATA_ROOM_STATUSES).optional() }).strict();
const folderBody = z
  .object({ name: z.string().trim().min(1).max(DATA_ROOM_LIMITS.folderNameChars) })
  .strict();
const folderOrderBody = z
  .object({ folderIds: z.array(uuid).max(DATA_ROOM_LIMITS.foldersPerRoom) })
  .strict();

/** The text fields that ride beside an uploaded document. */
export const documentUploadFields = z
  .object({
    folderId: z.union([uuid, z.literal("")]).optional(),
    title: z.string().trim().max(DATA_ROOM_LIMITS.documentTitleChars).optional(),
  })
  .strict();

const fromResourceBody = z
  .object({
    resourceId: uuid,
    folderId: uuid.nullable().optional(),
    title: z.string().trim().min(1).max(DATA_ROOM_LIMITS.documentTitleChars).optional(),
  })
  .strict();

const updateDocumentBody = z
  .object({
    title: z.string().trim().min(1).max(DATA_ROOM_LIMITS.documentTitleChars).optional(),
    folderId: uuid.nullable().optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const fileQuery = z.object({ download: z.enum(["0", "1"]).optional() }).strict();

const textQuery = z
  .object({
    offset: z.coerce.number().int().min(0).optional(),
    maxChars: z.coerce.number().int().min(1).max(200_000).optional(),
  })
  .strict();

const inviteBody = z
  .object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().min(3).max(320),
    organization: z.string().trim().max(160).optional(),
    folderIds: z.array(uuid).max(DATA_ROOM_LIMITS.foldersPerRoom).optional(),
    expiresAt: isoDateTime.nullable().optional(),
    sendInvitation: z.boolean().optional(),
    message: z.string().max(2_000).optional(),
  })
  .strict();

const updateGuestBody = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    organization: z.string().trim().max(160).optional(),
    folderIds: z.array(uuid).max(DATA_ROOM_LIMITS.foldersPerRoom).optional(),
    expiresAt: isoDateTime.nullable().optional(),
  })
  .strict();

const reissueBody = z.object({ sendInvitation: z.boolean().optional() }).strict().default({});
const resendBody = z
  .object({ message: z.string().max(2_000).optional() })
  .strict()
  .default({});
const questionsQuery = z
  .object({ status: z.enum(DATA_ROOM_QUESTION_STATUSES).optional() })
  .strict();
const answerBody = z
  .object({
    answer: z.string().trim().min(1).max(DATA_ROOM_LIMITS.answerChars),
    citations: z.array(citation).max(DATA_ROOM_LIMITS.citationsPerAnswer).optional(),
  })
  .strict();
const activityQuery = z
  .object({ feedLimit: z.coerce.number().int().min(0).max(500).optional() })
  .strict();
const grantBody = z.object({ accessLevel: z.enum(DATA_ROOM_ACCESS_LEVELS) }).strict();

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function param(req: Request, name: string): string {
  return (req.params as Record<string, string>)[name];
}

function actor(req: Request): DataRoomActor {
  if (!req.userId) throw new DataRoomValidationError("A signed-in Member is required.");
  return { kind: "user", userId: req.userId };
}

function route(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch((error: unknown) => {
      if (isDataRoomError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

async function cleanupUpload(req: Request): Promise<void> {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (file?.path) await fs.promises.unlink(file.path).catch(() => undefined);
}

const acceptDocumentUpload: RequestHandler = (req, res, next) => {
  dataRoomUploadMiddleware(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    void cleanupUpload(req).finally(() => {
      if (error instanceof multer.MulterError) {
        res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
          error:
            error.code === "LIMIT_FILE_SIZE"
              ? "A document must be 50 MB or smaller."
              : "The upload is invalid.",
        });
        return;
      }
      if (isDataRoomError(error)) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  });
};

// ── AI access (before `/data-rooms/:roomId`, which would match it) ─────────

dataRoomsRouter.get(
  "/data-rooms/ai-access",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ rows: await listDataRoomGrants(cid(req)) });
  }),
);

dataRoomsRouter.put(
  "/data-rooms/ai-access/:employeeId",
  validateParams(employeeParams),
  validateBody(grantBody),
  route(async (req, res) => {
    const grant = await upsertDataRoomGrant(
      cid(req),
      param(req, "employeeId"),
      req.body.accessLevel,
    );
    res.json({ id: grant.id, employeeId: grant.employeeId, accessLevel: grant.accessLevel });
  }),
);

dataRoomsRouter.delete(
  "/data-rooms/ai-access/:employeeId",
  validateParams(employeeParams),
  route(async (req, res) => {
    if (!(await deleteDataRoomGrant(cid(req), param(req, "employeeId")))) {
      res.status(404).json({ error: "Data room Grant not found" });
      return;
    }
    res.status(204).end();
  }),
);

// ── Rooms ──────────────────────────────────────────────────────────────────

dataRoomsRouter.get(
  "/data-rooms",
  validateParams(companyParams),
  validateQuery(listRoomsQuery),
  route(async (req, res) => {
    const query = req.query as z.infer<typeof listRoomsQuery>;
    res.json(await roomListView(cid(req), { status: query.status }));
  }),
);

dataRoomsRouter.post(
  "/data-rooms",
  validateParams(companyParams),
  validateBody(createRoomBody),
  route(async (req, res) => {
    const room = await createDataRoom({ companyId: cid(req), ...req.body, actor: actor(req) });
    res.status(201).json(await roomDetailView(cid(req), room.id));
  }),
);

dataRoomsRouter.get(
  "/data-rooms/:roomId",
  validateParams(roomParams),
  route(async (req, res) => {
    res.json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

dataRoomsRouter.patch(
  "/data-rooms/:roomId",
  validateParams(roomParams),
  validateBody(updateRoomBody),
  route(async (req, res) => {
    await updateDataRoom({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      patch: req.body,
      actor: actor(req),
    });
    res.json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

dataRoomsRouter.delete(
  "/data-rooms/:roomId",
  validateParams(roomParams),
  route(async (req, res) => {
    await deleteDataRoom({ companyId: cid(req), roomId: param(req, "roomId"), actor: actor(req) });
    res.status(204).end();
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/readiness",
  validateParams(roomParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await requestRoomReview({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      kind: "readiness",
    });
    res.status(202).json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/insights",
  validateParams(roomParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await requestRoomReview({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      kind: "insights",
    });
    res.status(202).json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

dataRoomsRouter.get(
  "/data-rooms/:roomId/activity",
  validateParams(roomParams),
  validateQuery(activityQuery),
  route(async (req, res) => {
    const room = await requireRoom(cid(req), param(req, "roomId"));
    const query = req.query as z.infer<typeof activityQuery>;
    res.json(await roomActivity(room, { feedLimit: query.feedLimit ?? 100 }));
  }),
);

// ── Folders ────────────────────────────────────────────────────────────────

dataRoomsRouter.post(
  "/data-rooms/:roomId/folders",
  validateParams(roomParams),
  validateBody(folderBody),
  route(async (req, res) => {
    const folder = await createFolder({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      name: req.body.name,
      actor: actor(req),
    });
    const folders = await listFolders(param(req, "roomId"));
    res
      .status(201)
      .json(serializeFolder(folder, folders.findIndex((item) => item.id === folder.id) + 1));
  }),
);

dataRoomsRouter.put(
  "/data-rooms/:roomId/folders/order",
  validateParams(roomParams),
  validateBody(folderOrderBody),
  route(async (req, res) => {
    const folders = await reorderFolders({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      folderIds: req.body.folderIds,
      actor: actor(req),
    });
    res.json({ folders: folders.map((folder, index) => serializeFolder(folder, index + 1)) });
  }),
);

dataRoomsRouter.patch(
  "/data-rooms/:roomId/folders/:folderId",
  validateParams(folderParams),
  validateBody(folderBody),
  route(async (req, res) => {
    const folder = await renameFolder({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      folderId: param(req, "folderId"),
      name: req.body.name,
      actor: actor(req),
    });
    const folders = await listFolders(param(req, "roomId"));
    res.json(serializeFolder(folder, folders.findIndex((item) => item.id === folder.id) + 1));
  }),
);

dataRoomsRouter.delete(
  "/data-rooms/:roomId/folders/:folderId",
  validateParams(folderParams),
  route(async (req, res) => {
    await deleteFolder({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      folderId: param(req, "folderId"),
      actor: actor(req),
    });
    res.status(204).end();
  }),
);

// ── Documents ──────────────────────────────────────────────────────────────

dataRoomsRouter.post(
  "/data-rooms/:roomId/documents",
  validateParams(roomParams),
  acceptDocumentUpload,
  route(async (req, res) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    try {
      if (!file) {
        res.status(400).json({ error: "Choose a file to upload." });
        return;
      }
      const parsed = documentUploadFields.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
        return;
      }
      const document = await addDocumentFromUpload({
        companyId: cid(req),
        roomId: param(req, "roomId"),
        file,
        folderId: parsed.data.folderId || null,
        title: parsed.data.title,
        actor: actor(req),
      });
      res.status(201).json(serializeDocument(document));
    } finally {
      await cleanupUpload(req);
    }
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/documents/from-resource",
  validateParams(roomParams),
  validateBody(fromResourceBody),
  route(async (req, res) => {
    const document = await addDocumentFromResource({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      resource: { id: req.body.resourceId },
      folderId: req.body.folderId ?? null,
      title: req.body.title,
      actor: actor(req),
    });
    res.status(201).json(serializeDocument(document));
  }),
);

dataRoomsRouter.patch(
  "/data-rooms/:roomId/documents/:documentId",
  validateParams(documentParams),
  validateBody(updateDocumentBody),
  route(async (req, res) => {
    const document = await updateDocument({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      documentId: param(req, "documentId"),
      ...req.body,
      actor: actor(req),
    });
    res.json(serializeDocument(document));
  }),
);

dataRoomsRouter.delete(
  "/data-rooms/:roomId/documents/:documentId",
  validateParams(documentParams),
  route(async (req, res) => {
    await deleteDocument({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      documentId: param(req, "documentId"),
      actor: actor(req),
    });
    res.status(204).end();
  }),
);

dataRoomsRouter.get(
  "/data-rooms/:roomId/documents/:documentId/file",
  validateParams(documentParams),
  validateQuery(fileQuery),
  route(async (req, res) => {
    const room = await requireRoom(cid(req), param(req, "roomId"));
    const document = await requireDocument(room.id, param(req, "documentId"));
    const file = documentFile(document);
    const query = req.query as z.infer<typeof fileQuery>;
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", String(file.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      contentDisposition(file.filename, query.download === "1" ? "attachment" : "inline"),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("ETag", `"sha256-${file.sha256}"`);
    res.sendFile(file.path);
  }),
);

dataRoomsRouter.get(
  "/data-rooms/:roomId/documents/:documentId/text",
  validateParams(documentParams),
  validateQuery(textQuery),
  route(async (req, res) => {
    const room = await requireRoom(cid(req), param(req, "roomId"));
    const document = await requireDocument(room.id, param(req, "documentId"));
    const query = req.query as z.infer<typeof textQuery>;
    res.json({
      textStatus: document.textStatus,
      ...(await readDocumentText(document, { offset: query.offset, maxChars: query.maxChars })),
    });
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/documents/:documentId/brief",
  validateParams(documentParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await requestBrief({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      documentId: param(req, "documentId"),
    });
    res.status(202).json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/briefs",
  validateParams(roomParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await requestMissingBriefs({ companyId: cid(req), roomId: param(req, "roomId") });
    res.status(202).json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

// ── Guests ─────────────────────────────────────────────────────────────────

dataRoomsRouter.get(
  "/data-rooms/:roomId/guests",
  validateParams(roomParams),
  route(async (req, res) => {
    const room = await requireRoom(cid(req), param(req, "roomId"));
    res.json({ guests: (await listGuests(room.id)).map(serializeGuest) });
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/guests",
  validateParams(roomParams),
  validateBody(inviteBody),
  route(async (req, res) => {
    const result = await inviteGuest({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      ...req.body,
      expiresAt: dateOrNull(req.body.expiresAt),
      actor: actor(req),
    });
    res
      .status(201)
      .json({ guest: serializeGuest(result.guest), link: result.link, delivery: result.delivery });
  }),
);

dataRoomsRouter.patch(
  "/data-rooms/:roomId/guests/:guestId",
  validateParams(guestParams),
  validateBody(updateGuestBody),
  route(async (req, res) => {
    const guest = await updateGuest({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      guestId: param(req, "guestId"),
      ...req.body,
      expiresAt: dateOrNull(req.body.expiresAt),
      actor: actor(req),
    });
    res.json(serializeGuest(guest));
  }),
);

for (const [path, status] of [
  ["/data-rooms/:roomId/guests/:guestId/revoke", "revoked"],
  ["/data-rooms/:roomId/guests/:guestId/restore", "active"],
] as const) {
  dataRoomsRouter.post(
    path,
    validateParams(guestParams),
    validateBody(emptyBody),
    route(async (req, res) => {
      const guest = await setGuestStatus({
        companyId: cid(req),
        roomId: param(req, "roomId"),
        guestId: param(req, "guestId"),
        status,
        actor: actor(req),
      });
      res.json(serializeGuest(guest));
    }),
  );
}

dataRoomsRouter.get(
  "/data-rooms/:roomId/guests/:guestId/link",
  validateParams(guestParams),
  route(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      link: await guestLinkFor({
        companyId: cid(req),
        roomId: param(req, "roomId"),
        guestId: param(req, "guestId"),
      }),
    });
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/guests/:guestId/reissue-link",
  validateParams(guestParams),
  validateBody(reissueBody),
  route(async (req, res) => {
    const result = await reissueGuestLink({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      guestId: param(req, "guestId"),
      sendInvitation: req.body.sendInvitation,
      actor: actor(req),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ guest: serializeGuest(result.guest), link: result.link, delivery: result.delivery });
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/guests/:guestId/resend",
  validateParams(guestParams),
  validateBody(resendBody),
  route(async (req, res) => {
    const result = await resendInvitation({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      guestId: param(req, "guestId"),
      message: req.body.message,
      actor: actor(req),
    });
    res.json({ guest: serializeGuest(result.guest), delivery: result.delivery });
  }),
);

// ── Questions ──────────────────────────────────────────────────────────────

dataRoomsRouter.get(
  "/data-rooms/:roomId/questions",
  validateParams(roomParams),
  validateQuery(questionsQuery),
  route(async (req, res) => {
    const room = await requireRoom(cid(req), param(req, "roomId"));
    const query = req.query as z.infer<typeof questionsQuery>;
    res.json(await questionsView(room.id, { status: query.status }));
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/questions/:questionId/answer",
  validateParams(questionParams),
  validateBody(answerBody),
  route(async (req, res) => {
    const question = await answerQuestion({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      questionId: param(req, "questionId"),
      answer: req.body.answer,
      citations: req.body.citations,
      actor: actor(req),
    });
    res.json(await questionView(question));
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/questions/:questionId/publish-draft",
  validateParams(questionParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    const question = await publishDraft({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      questionId: param(req, "questionId"),
      actor: actor(req),
    });
    res.json(await questionView(question));
  }),
);

dataRoomsRouter.post(
  "/data-rooms/:roomId/questions/:questionId/draft",
  validateParams(questionParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await requestDraft({
      companyId: cid(req),
      roomId: param(req, "roomId"),
      questionId: param(req, "questionId"),
    });
    res.status(202).json(await roomDetailView(cid(req), param(req, "roomId")));
  }),
);

for (const [path, status] of [
  ["/data-rooms/:roomId/questions/:questionId/close", "closed"],
  ["/data-rooms/:roomId/questions/:questionId/reopen", "open"],
] as const) {
  dataRoomsRouter.post(
    path,
    validateParams(questionParams),
    validateBody(emptyBody),
    route(async (req, res) => {
      const question = await setQuestionStatus({
        companyId: cid(req),
        roomId: param(req, "roomId"),
        questionId: param(req, "questionId"),
        status,
        actor: actor(req),
      });
      res.json(await questionView(question));
    }),
  );
}
