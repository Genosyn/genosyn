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
  claimAction,
  composeActionInstruction,
  dismissQuestionAction,
  loadRunnableAction,
  settleAction,
  TldrQuestionActionValidationError,
} from "../services/tldrQuestionActions.js";
import {
  deleteTldrQuestion,
  listTldrQuestions,
  runTldrQuestionTurn,
  TLDR_QUESTION_MESSAGE_MAX_CHARS,
  TLDR_QUESTION_PROMPT_MAX_CHARS,
} from "../services/tldrQuestions.js";
import {
  listStandingQuestions,
  MAX_STANDING_QUESTIONS,
  replaceStandingQuestions,
} from "../services/tldrStandingQuestions.js";
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

/**
 * The standing questions, edited as one list with one Save.
 *
 * Sent whole rather than as per-row requests: reordering three questions and
 * deleting a fourth is one intent, and a half-applied save is a state nobody
 * asked for. Omitting the field leaves the list untouched, so an older client
 * saving a cadence cannot silently wipe questions it does not know about.
 */
const standingQuestionSchema = z
  .object({
    id: z.string().uuid().nullable().optional(),
    prompt: z.string().trim().min(1).max(TLDR_QUESTION_PROMPT_MAX_CHARS),
    enabled: z.boolean(),
  })
  .strict();

const settingsBodySchema = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(TLDR_CADENCES),
    employeeId: z.string().uuid().nullable(),
    questions: z.array(standingQuestionSchema).max(MAX_STANDING_QUESTIONS).optional(),
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
    // Composed here rather than inside `getTldrSettings`: the standing-question
    // service reaches the question-turn runner, which reaches back into
    // `tldrs`, and one page's response shape is not worth a module cycle.
    const [settings, questions] = await Promise.all([
      getTldrSettings(cid(req)),
      listStandingQuestions(cid(req)),
    ]);
    res.json({ ...settings, questions });
  }),
);

tldrsRouter.put(
  "/tldrs/settings",
  validateBody(settingsBodySchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof settingsBodySchema>;
    const settings = await updateTldrSettings(cid(req), body);
    const questions = body.questions
      ? await replaceStandingQuestions({
          companyId: cid(req),
          userId: req.userId ?? null,
          questions: body.questions,
        })
      : await listStandingQuestions(cid(req));
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
        standingQuestions: questions.length,
      },
    });
    res.json({ ...settings, questions });
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
        onSuggestedActions: (actions) => emit("suggested_actions", { actions }),
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

// ─────────────────────────── suggested actions ───────────────────────────

const actionParamsSchema = z
  .object({
    cid: z.string().uuid(),
    id: z.string().uuid(),
    qid: z.string().uuid(),
    aid: z.string().uuid(),
  })
  .strict();

/**
 * Press one suggested action.
 *
 * Deliberately the same stream, and the same turn, as typing a follow-up. The
 * only difference is who wrote the sentence: the employee proposed it, the
 * Member read it on the button, and the server replays it verbatim as that
 * Member's own instruction under that Member's own authority. A button is not
 * a privilege escalation and this route is where that stays true — there is no
 * branch here that reaches a tool the composer could not.
 */
tldrsRouter.post(
  "/tldrs/:id/questions/:qid/actions/:aid/run",
  requireBrowserSession,
  validateParams(actionParamsSchema),
  validateBody(emptyBodySchema),
  questionStream(async (req, emit) => {
    const action = await loadRunnableAction({
      companyId: cid(req),
      tldrId: req.params.id as string,
      questionId: req.params.qid as string,
      actionId: req.params.aid as string,
    });
    // Owner/admin-gated kinds are refused here as well as greyed out in the
    // UI: a disabled button is a courtesy, not a boundary.
    if (
      action.kind === "routine" &&
      req.companyRole !== "owner" &&
      req.companyRole !== "admin"
    ) {
      throw new TldrQuestionActionValidationError(
        "Creating or changing a Routine is an owner or admin action. Ask one of them to run this.",
      );
    }
    // Two Members pressing the same button in the same second get one turn.
    if (!(await claimAction(action.id))) {
      throw new TldrQuestionActionValidationError(
        "Somebody just started this action. Give it a moment to finish.",
      );
    }
    emit("action", { id: action.id, status: "running" });
    try {
      await runTldrQuestionTurn({
        companyId: cid(req),
        tldrId: req.params.id as string,
        questionId: req.params.qid as string,
        message: composeActionInstruction(action),
        actionId: action.id,
        userId: req.userId!,
        requesterSessionVersion: req.session!.sessionVersion!,
        callbacks: {
          onUser: (message) => emit("user", message),
          onWorking: (message) => emit("working", message),
          onChunk: (text) => emit("chunk", { text }),
          onAssistant: (message) => emit("assistant", message),
          // The terminal frame for the button, fired on every path the turn
          // owns — done, refused, or interrupted.
          onAction: (settled) => emit("action", settled),
        },
      });
    } catch (error) {
      // The turn settles the action on every path it owns, including its own
      // failures. This only covers a throw that escapes it entirely — leaving
      // a claimed button unpressable forever would be a worse bug than the one
      // that caused it.
      await settleAction(action.id, { status: "proposed" });
      emit("action", { id: action.id, status: "proposed" });
      throw error;
    }
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.question.action.run",
      targetType: "tldr_question_action",
      targetId: action.id,
      targetLabel: action.label.slice(0, 160),
      metadata: { tldrId: req.params.id, questionId: req.params.qid, kind: action.kind },
    });
  }),
);

tldrsRouter.delete(
  "/tldrs/:id/questions/:qid/actions/:aid",
  validateParams(actionParamsSchema),
  h(async (req, res) => {
    const action = await dismissQuestionAction({
      companyId: cid(req),
      tldrId: req.params.id,
      questionId: req.params.qid,
      actionId: req.params.aid,
    });
    await recordAudit({
      companyId: cid(req),
      actorUserId: req.userId ?? null,
      action: "tldr.question.action.dismiss",
      targetType: "tldr_question_action",
      targetId: action.id,
      targetLabel: action.label.slice(0, 160),
      metadata: { tldrId: action.tldrId, questionId: action.questionId },
    });
    res.json({ ok: true });
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
