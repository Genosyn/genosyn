import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";

import { TLDR_CADENCES } from "../db/entities/TldrSettings.js";
import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  deleteTldrQuestion,
  listTldrQuestions,
  runTldrQuestionTurn,
  TLDR_QUESTION_MESSAGE_MAX_CHARS,
  TLDR_QUESTION_PROMPT_MAX_CHARS,
} from "../services/tldrQuestions.js";
import {
  dismissTldr,
  generateTldrNow,
  getTldrSettings,
  listTldrs,
  questionCounts,
  serializeTldr,
  updateTldrSettings,
} from "../services/tldrs.js";

export const tldrsRouter = Router({ mergeParams: true });
tldrsRouter.use(requireAuth);
tldrsRouter.use(requireCompanyMember);
tldrsRouter.use(
  onRoutePaths(["/tldrs/settings", "/tldrs/generate"], requireCompanyRoleForMutations("admin")),
);

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status)
          : 0;
      if (status >= 400 && status < 600) {
        res.status(status).json({
          error: error instanceof Error ? error.message : "TLDR request failed.",
        });
        return;
      }
      next(error);
    });
  };
}

const listQuerySchema = z
  .object({
    before: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

const settingsBodySchema = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(TLDR_CADENCES),
    employeeId: z.string().uuid().nullable(),
  })
  .strict();

const tldrParamsSchema = z.object({ cid: z.string().uuid(), id: z.string().uuid() }).strict();

const emptyBodySchema = z.object({}).strict().default({});

tldrsRouter.get(
  "/tldrs",
  h(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    res.json(
      await listTldrs({
        companyId: cid(req),
        userId: req.userId!,
        limit: parsed.data.limit,
        before: parsed.data.before ? new Date(parsed.data.before) : undefined,
      }),
    );
  }),
);

tldrsRouter.get(
  "/tldrs/settings",
  h(async (req, res) => {
    res.json(await getTldrSettings(cid(req)));
  }),
);

tldrsRouter.put(
  "/tldrs/settings",
  validateBody(settingsBodySchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof settingsBodySchema>;
    const settings = await updateTldrSettings(cid(req), body);
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.settings.update",
      targetType: "tldr_settings",
      targetId: settings.id,
      targetLabel: "TLDR settings",
      metadata: {
        enabled: settings.enabled,
        cadence: settings.cadence,
        employeeId: settings.employeeId,
      },
    });
    res.json(settings);
  }),
);

tldrsRouter.post(
  "/tldrs/generate",
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    const tldr = await generateTldrNow(cid(req));
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.generate.manual",
      targetType: "tldr",
      targetId: tldr?.id ?? null,
      targetLabel: tldr?.title ?? "Empty TLDR window",
      metadata: tldr
        ? { sourceStats: JSON.parse(tldr.sourceStatsJson) as unknown }
        : { empty: true },
    });
    if (!tldr) {
      res.json({ status: "empty" });
      return;
    }
    res.json({ status: "created", tldr: serializeTldr(tldr, false) });
  }),
);

tldrsRouter.post(
  "/tldrs/:id/dismiss",
  validateParams(tldrParamsSchema),
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    const result = await dismissTldr({
      companyId: cid(req),
      tldrId: req.params.id,
      userId: req.userId!,
    });
    if (result.created) {
      await recordAudit({
        companyId: cid(req),
        actorUserId: req.userId ?? null,
        action: "tldr.dismiss",
        targetType: "tldr",
        targetId: result.tldr.id,
        targetLabel: result.tldr.title,
      });
    }
    const counts = await questionCounts([result.tldr.id]);
    res.json(serializeTldr(result.tldr, true, counts.get(result.tldr.id) ?? 0));
  }),
);

// ───────────────────────────── question cards ─────────────────────────────

const questionParamsSchema = z
  .object({ cid: z.string().uuid(), id: z.string().uuid(), qid: z.string().uuid() })
  .strict();

const askQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(TLDR_QUESTION_PROMPT_MAX_CHARS),
    modelId: z.string().uuid().nullable().optional().default(null),
  })
  .strict();

const questionMessageSchema = z
  .object({
    message: z.string().trim().min(1).max(TLDR_QUESTION_MESSAGE_MAX_CHARS),
    modelId: z.string().uuid().nullable().optional().default(null),
  })
  .strict();

/**
 * How often a card's turn stream emits an SSE keepalive comment. A reply can
 * spend minutes between visible chunks while the employee reads the briefing
 * and runs tools, and any idle reverse proxy in front of a self-hosted Genosyn
 * (nginx `proxy_read_timeout` 60s, Caddy, cloud load balancers at 30–100s)
 * resets a silent connection — which the browser reports as a bare `network
 * error` mid-reply. Same value every other stream in the product uses.
 */
const TLDR_QUESTION_STREAM_HEARTBEAT_MS = 15_000;

/**
 * One card turn, streamed over SSE. Event grammar: `question` (ask flow only)
 * → `user` (discuss flow only) → `working` → `chunk*` → `assistant` → `done`.
 * Errors arrive as events too, so the client's rendering stays uniform.
 *
 * The turn is not tied to this connection: once `working` has been written the
 * row owns the reply, and a client that loses the stream re-reads it from the
 * card list instead of losing the answer.
 */
function questionStream(
  run: (req: Request, emit: (event: string, data: unknown) => void) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(`: keepalive\n\n`);
    }, TLDR_QUESTION_STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on("close", () => clearInterval(heartbeat));

    run(req, writeEvent)
      .then(() => {
        writeEvent("done", {});
        if (!res.writableEnded && !res.destroyed) res.end();
      })
      .catch((error: unknown) => {
        if (!res.writableEnded && !res.destroyed) {
          writeEvent("error", {
            message: error instanceof Error ? error.message : "This reply could not be started.",
          });
          writeEvent("done", {});
          res.end();
        } else if (!res.destroyed) {
          next(error);
        }
      })
      .finally(() => clearInterval(heartbeat));
  };
}

tldrsRouter.get(
  "/tldrs/:id/questions",
  validateParams(tldrParamsSchema),
  h(async (req, res) => {
    res.json(
      await listTldrQuestions({
        companyId: cid(req),
        tldrId: req.params.id,
        userId: req.userId!,
      }),
    );
  }),
);

tldrsRouter.post(
  "/tldrs/:id/questions",
  requireBrowserSession,
  validateParams(tldrParamsSchema),
  validateBody(askQuestionSchema),
  questionStream(async (req, emit) => {
    const body = req.body as z.infer<typeof askQuestionSchema>;
    let askedId: string | null = null;
    await runTldrQuestionTurn({
      companyId: cid(req),
      tldrId: req.params.id as string,
      prompt: body.prompt,
      modelId: body.modelId,
      userId: req.userId!,
      requesterSessionVersion: req.session!.sessionVersion!,
      callbacks: {
        onQuestion: (question) => {
          askedId = question.id;
          emit("question", question);
        },
        onUser: (message) => emit("user", message),
        onWorking: (message) => emit("working", message),
        onChunk: (text) => emit("chunk", { text }),
        onAssistant: (message) => emit("assistant", message),
      },
    });
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.question.ask",
      targetType: "tldr_question",
      targetId: askedId,
      targetLabel: body.prompt.slice(0, 160),
      metadata: { tldrId: req.params.id },
    });
  }),
);

tldrsRouter.post(
  "/tldrs/:id/questions/:qid/messages",
  requireBrowserSession,
  validateParams(questionParamsSchema),
  validateBody(questionMessageSchema),
  // No audit row per message: the conversation is not the change. Anything the
  // employee actually does on this turn audits itself at the tool boundary.
  questionStream(async (req, emit) => {
    const body = req.body as z.infer<typeof questionMessageSchema>;
    await runTldrQuestionTurn({
      companyId: cid(req),
      tldrId: req.params.id as string,
      questionId: req.params.qid as string,
      message: body.message,
      modelId: body.modelId,
      userId: req.userId!,
      requesterSessionVersion: req.session!.sessionVersion!,
      callbacks: {
        onQuestion: () => {},
        onUser: (message) => emit("user", message),
        onWorking: (message) => emit("working", message),
        onChunk: (text) => emit("chunk", { text }),
        onAssistant: (message) => emit("assistant", message),
      },
    });
  }),
);

tldrsRouter.delete(
  "/tldrs/:id/questions/:qid",
  validateParams(questionParamsSchema),
  h(async (req, res) => {
    const question = await deleteTldrQuestion({
      companyId: cid(req),
      tldrId: req.params.id,
      questionId: req.params.qid,
      userId: req.userId!,
      isAdmin: req.companyRole === "owner" || req.companyRole === "admin",
    });
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.question.delete",
      targetType: "tldr_question",
      targetId: question.id,
      targetLabel: question.prompt.slice(0, 160),
      metadata: { tldrId: question.tldrId },
    });
    res.json({ ok: true });
  }),
);
