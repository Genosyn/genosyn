import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  explainRun,
  runExplanationOptions,
  RunExplanationError,
} from "../services/runExplanations.js";

const paramsSchema = z.object({ cid: z.string().uuid(), runId: z.string().uuid() }).strict();
const bodySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(4_000).optional(),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(8_000),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.history ?? []).reduce((length, turn) => length + turn.content.length, 0) <= 32_000,
    {
      message: "Conversation history is too long. Keep the most recent messages.",
      path: ["history"],
    },
  );
const querySchema = z.object({}).strict();

/** Mounted ahead of the Routine mutation gate: asking why is open to every Member. */
export const runExplanationsRouter = Router({ mergeParams: true });
const path = "/runs/:runId/explanation";
const access = [
  requireAuth,
  requireBrowserSession,
  validateParams(paramsSchema),
  requireCompanyMember,
];

runExplanationsRouter.get(path, ...access, validateQuery(querySchema), async (req, res, next) => {
  try {
    res.json(await runExplanationOptions(req.params.cid, req.params.runId));
  } catch (error) {
    if (error instanceof RunExplanationError)
      return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

runExplanationsRouter.post(
  path,
  ...access,
  validateQuery(querySchema),
  validateBody(bodySchema),
  async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    const streaming = req.get("accept")?.includes("text/event-stream") === true;
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    let keepalive: ReturnType<typeof setInterval> | undefined;
    if (streaming) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": keepalive\n\n");
      keepalive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
      }, 15_000);
      keepalive.unref();
    }
    try {
      const body = req.body as z.infer<typeof bodySchema>;
      const result = await explainRun({
        companyId: req.params.cid,
        runId: req.params.runId,
        employeeId: body.employeeId,
        message: body.message,
        history: body.history,
        requesterUserId: req.userId!,
        requesterSessionVersion: req.user!.sessionVersion,
        signal: controller.signal,
      });
      if (streaming) send("explanation", result);
      else res.json(result);
    } catch (error) {
      if (streaming) {
        send("error", {
          error:
            error instanceof RunExplanationError
              ? error.message
              : "The AI Employee could not explain this Run. Try again.",
        });
        return;
      }
      if (error instanceof RunExplanationError)
        return res.status(error.status).json({ error: error.message });
      next(error);
    } finally {
      if (keepalive) clearInterval(keepalive);
      if (streaming && !res.writableEnded) res.end();
      res.off("close", abort);
    }
  },
);
