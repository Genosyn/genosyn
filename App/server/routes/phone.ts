import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { PhoneCall } from "../db/entities/PhoneCall.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  MAX_CALL_BRIEF_LENGTH,
  MAX_CALL_OPENING_LENGTH,
  MAX_DAILY_PHONE_LIMIT,
  MAX_PHONE_GREETING_LENGTH,
  MAX_TEXT_MESSAGE_LENGTH,
  PHONE_CALL_MODES,
  PHONE_TEXT_MODES,
  PHONE_INSTRUCTIONS_LIMITS,
} from "../../shared/phone.js";
import { getPublicUrl, isPublicUrlConfigured } from "../services/publicUrl.js";
import { listTwilioConnections } from "../services/phone/credentials.js";
import { phoneFailure } from "../services/phone/errors.js";
import {
  importPhoneNumber,
  listImportablePhoneNumbers,
  listPhoneNumbers,
  removePhoneNumber,
  requirePhoneNumber,
  reservePhoneNumber,
  searchAvailablePhoneNumbers,
  serializePhoneNumbers,
  syncPhoneNumberWebhooks,
  updatePhoneNumber,
} from "../services/phone/numbers.js";
import {
  aiTextsInLastDay,
  listTexts,
  sendText,
  serializePhoneMessage,
} from "../services/phone/texts.js";
import {
  aiCallsInLastDay,
  endCall,
  listCalls,
  placeCall,
  serializeCall,
} from "../services/phone/calls.js";
import { reachableBaseUrl } from "../services/phone/webhookUrls.js";

/**
 * Settings → Phone numbers, and the Phone pane on an AI Employee.
 * Mounted under `/api/companies/:cid/phone`.
 *
 * Owner/admin only, reads included. A number's texts carry verification codes
 * for the accounts its AI Employee signs into, and its calls carry whatever
 * strangers said on them — as sensitive as the Vault, so nobody below admin
 * reads them. Reserving and releasing numbers also spends the company's money.
 */
export const phoneRouter = Router({ mergeParams: true });
phoneRouter.use(requireAuth);
phoneRouter.use(requireCompanyMember);
phoneRouter.use(requireBrowserSession);
phoneRouter.use(requireCompanyRole("admin"));

type Params = { cid: string; id?: string; callId?: string };

function cid(req: { params: unknown }): string {
  return (req.params as Params).cid;
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  const known = phoneFailure(err);
  if (known) {
    res.status(known.status).json({ error: known.message });
    return;
  }
  next(err);
}

const numberParams = z.object({ cid: z.string(), id: z.string().uuid() });
const callParams = z.object({ cid: z.string(), callId: z.string().uuid() });

phoneRouter.get("/setup", async (req, res, next) => {
  try {
    const connections = await listTwilioConnections(cid(req));
    res.json({
      connections: connections.map((c) => ({
        id: c.id,
        label: c.label,
        accountHint: c.accountHint,
        status: c.status,
        statusMessage: c.statusMessage,
      })),
      publicUrl: {
        configured: isPublicUrlConfigured(),
        reachable: reachableBaseUrl() !== null,
        url: isPublicUrlConfigured() ? getPublicUrl() : null,
      },
    });
  } catch (err) {
    fail(res, next, err);
  }
});

const listQuery = z.object({ employeeId: z.string().uuid().optional() });

phoneRouter.get("/numbers", validateQuery(listQuery), async (req, res, next) => {
  try {
    const { employeeId } = req.query as z.infer<typeof listQuery>;
    const numbers = await listPhoneNumbers(cid(req));
    res.json(
      await serializePhoneNumbers(
        employeeId ? numbers.filter((n) => n.employeeId === employeeId) : numbers,
      ),
    );
  } catch (err) {
    fail(res, next, err);
  }
});

const searchQuery = z.object({
  connectionId: z.string().uuid(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, e.g. US"),
  type: z.enum(["local", "toll-free", "mobile"]).default("local"),
  areaCode: z
    .string()
    .trim()
    .regex(/^\d{0,6}$/, "Area codes are digits")
    .optional(),
  contains: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z*]{0,16}$/, "Use digits, letters or *")
    .optional(),
});

phoneRouter.get("/available", validateQuery(searchQuery), async (req, res, next) => {
  try {
    const q = req.query as z.infer<typeof searchQuery>;
    res.json(
      await searchAvailablePhoneNumbers({
        companyId: cid(req),
        connectionId: q.connectionId,
        country: q.country,
        type: q.type,
        areaCode: q.areaCode || undefined,
        contains: q.contains || undefined,
      }),
    );
  } catch (err) {
    fail(res, next, err);
  }
});

const reserveSchema = z.object({
  connectionId: z.string().uuid(),
  phoneNumber: z.string().min(4).max(32),
  employeeId: z.string().uuid().nullable().default(null),
  label: z.string().max(80).default(""),
  country: z.string().max(2).default(""),
  locality: z.string().max(120).default(""),
});

phoneRouter.post("/numbers", validateBody(reserveSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof reserveSchema>;
    const number = await reservePhoneNumber({
      companyId: cid(req),
      ...body,
      userId: req.userId ?? null,
    });
    const [dto] = await serializePhoneNumbers([number]);
    res.json(dto);
  } catch (err) {
    fail(res, next, err);
  }
});

const importableQuery = z.object({ connectionId: z.string().uuid() });

phoneRouter.get("/importable", validateQuery(importableQuery), async (req, res, next) => {
  try {
    const { connectionId } = req.query as z.infer<typeof importableQuery>;
    res.json(await listImportablePhoneNumbers(cid(req), connectionId));
  } catch (err) {
    fail(res, next, err);
  }
});

const importSchema = z.object({
  connectionId: z.string().uuid(),
  sid: z.string().regex(/^PN[0-9a-fA-F]{32}$/, "Pick a number from your Twilio account"),
  employeeId: z.string().uuid().nullable().default(null),
  label: z.string().max(80).default(""),
});

phoneRouter.post("/numbers/import", validateBody(importSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof importSchema>;
    const number = await importPhoneNumber({
      companyId: cid(req),
      ...body,
      userId: req.userId ?? null,
    });
    const [dto] = await serializePhoneNumbers([number]);
    res.json(dto);
  } catch (err) {
    fail(res, next, err);
  }
});

phoneRouter.get("/numbers/:id", validateParams(numberParams), async (req, res, next) => {
  try {
    const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
    const [dto] = await serializePhoneNumbers([number]);
    const [textsToday, callsToday] = await Promise.all([
      aiTextsInLastDay(number.id),
      aiCallsInLastDay(number.id),
    ]);
    res.json({ ...dto, usage: { textsToday, callsToday } });
  } catch (err) {
    fail(res, next, err);
  }
});

const patchSchema = z
  .object({
    label: z.string().max(80),
    employeeId: z.string().uuid().nullable(),
    callMode: z.enum(PHONE_CALL_MODES as [string, ...string[]]),
    forwardTo: z.string().max(32).nullable(),
    textMode: z.enum(PHONE_TEXT_MODES as [string, ...string[]]),
    greeting: z.string().max(MAX_PHONE_GREETING_LENGTH * 2),
    instructions: z.string().max(PHONE_INSTRUCTIONS_LIMITS.maxLength * 2),
    voice: z.string().max(64),
    dailyTextLimit: z.number().int().min(0).max(MAX_DAILY_PHONE_LIMIT),
    dailyCallLimit: z.number().int().min(0).max(MAX_DAILY_PHONE_LIMIT),
  })
  .partial()
  .strict();

phoneRouter.patch(
  "/numbers/:id",
  validateParams(numberParams),
  validateBody(patchSchema),
  async (req, res, next) => {
    try {
      const patch = req.body as z.infer<typeof patchSchema>;
      const number = await updatePhoneNumber({
        companyId: cid(req),
        id: (req.params as Params).id!,
        patch: patch as Parameters<typeof updatePhoneNumber>[0]["patch"],
        userId: req.userId ?? null,
      });
      const [dto] = await serializePhoneNumbers([number]);
      res.json(dto);
    } catch (err) {
      fail(res, next, err);
    }
  },
);

phoneRouter.post("/numbers/:id/webhooks", validateParams(numberParams), async (req, res, next) => {
  try {
    const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
    const [dto] = await serializePhoneNumbers([await syncPhoneNumberWebhooks(number)]);
    res.json(dto);
  } catch (err) {
    fail(res, next, err);
  }
});

const removeQuery = z.object({
  release: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

phoneRouter.delete(
  "/numbers/:id",
  validateParams(numberParams),
  validateQuery(removeQuery),
  async (req, res, next) => {
    try {
      const { release } = req.query as unknown as z.infer<typeof removeQuery>;
      await removePhoneNumber({
        companyId: cid(req),
        id: (req.params as Params).id!,
        release,
        userId: req.userId ?? null,
      });
      res.json({ ok: true });
    } catch (err) {
      fail(res, next, err);
    }
  },
);

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

phoneRouter.get(
  "/numbers/:id/texts",
  validateParams(numberParams),
  validateQuery(pageQuery),
  async (req, res, next) => {
    try {
      const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
      const { limit } = req.query as unknown as z.infer<typeof pageQuery>;
      const texts = await listTexts({ phoneNumberIds: [number.id], limit });
      res.json(texts.map(serializePhoneMessage));
    } catch (err) {
      fail(res, next, err);
    }
  },
);

const sendSchema = z.object({
  to: z.string().min(4).max(32),
  body: z.string().min(1).max(MAX_TEXT_MESSAGE_LENGTH),
});

phoneRouter.post(
  "/numbers/:id/texts",
  validateParams(numberParams),
  validateBody(sendSchema),
  async (req, res, next) => {
    try {
      const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
      const body = req.body as z.infer<typeof sendSchema>;
      const message = await sendText({
        number,
        to: body.to,
        body: body.body,
        sender: { kind: "member", userId: req.userId! },
      });
      res.json(serializePhoneMessage(message));
    } catch (err) {
      fail(res, next, err);
    }
  },
);

phoneRouter.get(
  "/numbers/:id/calls",
  validateParams(numberParams),
  validateQuery(pageQuery),
  async (req, res, next) => {
    try {
      const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
      const { limit } = req.query as unknown as z.infer<typeof pageQuery>;
      const calls = await listCalls({ phoneNumberIds: [number.id], limit });
      res.json(calls.map((call) => serializeCall(call)));
    } catch (err) {
      fail(res, next, err);
    }
  },
);

const testCallSchema = z.object({
  to: z.string().min(4).max(32),
  brief: z.string().min(1).max(MAX_CALL_BRIEF_LENGTH),
  openingLine: z.string().max(MAX_CALL_OPENING_LENGTH).default(""),
});

phoneRouter.post(
  "/numbers/:id/calls",
  validateParams(numberParams),
  validateBody(testCallSchema),
  async (req, res, next) => {
    try {
      const number = await requirePhoneNumber(cid(req), (req.params as Params).id!);
      const body = req.body as z.infer<typeof testCallSchema>;
      const call = await placeCall({
        number,
        to: body.to,
        brief: body.brief,
        openingLine: body.openingLine,
        placer: { kind: "member", userId: req.userId! },
      });
      res.json(serializeCall(call));
    } catch (err) {
      fail(res, next, err);
    }
  },
);

function findCall(companyId: string, callId: string): Promise<PhoneCall | null> {
  return AppDataSource.getRepository(PhoneCall).findOneBy({ id: callId, companyId });
}

phoneRouter.get("/calls/:callId", validateParams(callParams), async (req, res, next) => {
  try {
    const call = await findCall(cid(req), (req.params as Params).callId!);
    if (!call) return res.status(404).json({ error: "Call not found" });
    res.json(serializeCall(call, { transcript: true }));
  } catch (err) {
    fail(res, next, err);
  }
});

phoneRouter.post("/calls/:callId/hang-up", validateParams(callParams), async (req, res, next) => {
  try {
    const call = await findCall(cid(req), (req.params as Params).callId!);
    if (!call) return res.status(404).json({ error: "Call not found" });
    const number = await requirePhoneNumber(cid(req), call.phoneNumberId);
    await endCall(call, number, req.userId ?? null);
    res.json({ ok: true });
  } catch (err) {
    fail(res, next, err);
  }
});
