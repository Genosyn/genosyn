import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  assistantAttachments,
  assistantRoster,
  clearAssistantMessages,
  lastAssistantModelId,
  listAssistantMessages,
  runAssistantTurn,
  serializeAssistantMessage,
} from "../services/routineAssistant.js";
import { recordAttachment, resolveAttachmentFile, uploadMiddleware } from "../services/uploads.js";

/**
 * Ask AI on a Routine — the HTTP surface for the chat rail beside one routine.
 *
 * Its own router, mounted *before* `routinesRouter`, and that ordering is the
 * point: `routinesRouter` gates every non-GET under `/routines` behind the
 * admin role, because creating and editing routines is company configuration.
 * Asking a question about one is not. Any Member who can open the routine page
 * can already read the routine and its Runs, so they can ask about it too —
 * and the turn runs with that Member's own authority, so anything the employee
 * *does* is still intersected with what they are allowed to do.
 *
 * `routineAssistant.test.ts` locks the ordering in with a non-admin member.
 */
export const routineAssistantRouter = Router({ mergeParams: true });
routineAssistantRouter.use(requireAuth);
routineAssistantRouter.use(requireCompanyMember);

/** The routine, scoped to the company through its owning employee. */
async function loadRoutine(cid: string, routineId: string): Promise<Routine | null> {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: routineId });
  if (!routine) return null;
  const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
    companyId: cid,
  });
  return owner ? routine : null;
}

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/** Panel bootstrap: this routine's conversation plus everyone tag-able on it. */
routineAssistantRouter.get("/routines/:rid/assistant", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const routine = await loadRoutine(cid, req.params.rid as string);
  if (!routine) return res.status(404).json({ error: "Routine not found" });
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const [messages, roster] = await Promise.all([
    listAssistantMessages(routine.id, parsed.data.limit),
    assistantRoster(cid, routine),
  ]);
  const attachments = await assistantAttachments(messages);
  // The employee the panel is talking to, and the brain their last answered
  // turn ran on — so reopening the panel resumes on the same model rather than
  // silently switching to whatever is active now.
  const lastAnswered = [...messages].reverse().find((m) => m.role === "assistant" && m.employeeId);
  const modelId = lastAnswered?.employeeId
    ? await lastAssistantModelId(routine.id, lastAnswered.employeeId)
    : null;
  res.json({
    messages: messages.map((m) => serializeAssistantMessage(m, attachments.get(m.id) ?? [])),
    roster,
    modelId,
  });
});

routineAssistantRouter.delete("/routines/:rid/assistant/messages", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const routine = await loadRoutine(cid, req.params.rid as string);
  if (!routine) return res.status(404).json({ error: "Routine not found" });
  await clearAssistantMessages(routine.id);
  res.json({ ok: true });
});

const sendSchema = z.object({
  message: z.string().min(1).max(8000),
  employeeId: z.string().uuid().optional(),
  /** Files uploaded through the route below, bound to this turn on send. */
  attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
  /** Employee-owned AI Model for this turn; null inherits the active one. */
  modelId: z.string().uuid().nullable().optional().default(null),
});

/**
 * Upload a file into a routine's AI chat — a spec to check the brief against,
 * a log somebody pulled off another system. It becomes an ordinary
 * `Attachment` row bound to the human's turn, so the employee sees it in its
 * prompt with an `attachmentId` it can pass to the document tools, which is
 * the same contract employee chat and the per-email panel use.
 */
routineAssistantRouter.post(
  "/routines/:rid/assistant/attachments",
  async (req, res, next) => {
    // The upload middleware writes into the company's attachment directory,
    // which it resolves from `req.company` — this router doesn't set it.
    const cid = (req.params as Record<string, string>).cid;
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    if (!company) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = company;
    next();
  },
  uploadMiddleware.single("file"),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const routine = await loadRoutine(cid, req.params.rid as string);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const company = (req as unknown as { company: Company }).company;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const row = await recordAttachment({
      companyId: company.id,
      companySlug: company.slug,
      file,
      uploadedByUserId: req.userId!,
    });
    res.status(201).json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        isImage: row.mimeType.startsWith("image/"),
      },
    });
  },
);

/**
 * Download a file from a routine's AI chat — either one the teammate uploaded
 * or one the employee produced. Scoped to attachments actually bound to a turn
 * of THIS routine's chat (plus the requester's own not-yet-sent upload), so an
 * attachment id from elsewhere in the company can't be read through here.
 */
routineAssistantRouter.get(
  "/routines/:rid/assistant/attachments/:attachmentId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const routine = await loadRoutine(cid, req.params.rid as string);
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const resolved = await resolveAttachmentFile(req.params.attachmentId as string, cid);
    const missing = { error: "Attachment not found" };
    if (!resolved) return res.status(404).json(missing);
    if (resolved.row.messageId) {
      const owner = await AppDataSource.getRepository(RoutineChatMessage).findOneBy({
        id: resolved.row.messageId,
        routineId: routine.id,
        companyId: cid,
      });
      if (!owner) return res.status(404).json(missing);
    } else if (resolved.row.uploadedByUserId !== req.userId) {
      return res.status(404).json(missing);
    }
    res.setHeader("content-type", resolved.row.mimeType);
    res.setHeader("x-content-type-options", "nosniff");
    const disposition = resolved.row.mimeType.startsWith("image/") ? "inline" : "attachment";
    res.setHeader(
      "content-disposition",
      `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
    );
    res.sendFile(resolved.absPath);
  },
);

/**
 * How often this stream emits an SSE keepalive comment. A turn can spend
 * minutes between visible `chunk` events while the employee reads the Run log
 * and runs tools, and any idle reverse proxy in front of a self-hosted Genosyn
 * (nginx `proxy_read_timeout` 60s, Caddy, cloud load balancers at 30–100s)
 * resets a silent connection — which the browser reports as a bare `network
 * error` mid-reply. A comment line every 15s stays under those timers. Same
 * value the employee chat and per-email streams use.
 */
const ASSISTANT_STREAM_HEARTBEAT_MS = 15_000;

/**
 * One assistant turn, streamed over SSE (same event grammar as employee chat
 * and the per-email panel): `user` → the persisted human turn, `target` → the
 * resolved employee, `working` → the persisted in-flight assistant row,
 * `chunk` → reply text deltas, `assistant` → the finalized reply, `done` → end
 * marker. Errors also arrive as events so the client rendering stays uniform.
 *
 * The turn is not tied to this connection: once `working` has been written the
 * row owns the reply, and a client that loses the stream re-reads it from the
 * panel bootstrap instead of losing the answer.
 */
routineAssistantRouter.post(
  "/routines/:rid/assistant/messages",
  requireBrowserSession,
  validateBody(sendSchema),
  async (req, res, next) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof sendSchema>;

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
    }, ASSISTANT_STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on("close", () => clearInterval(heartbeat));

    try {
      const routine = await loadRoutine(cid, req.params.rid as string);
      if (!routine) {
        writeEvent("error", { message: "Routine not found" });
        writeEvent("done", {});
        return res.end();
      }
      await runAssistantTurn({
        companyId: cid,
        routine,
        message: body.message,
        employeeId: body.employeeId,
        attachmentIds: body.attachmentIds,
        modelId: body.modelId,
        userId: req.userId!,
        requesterSessionVersion: req.session!.sessionVersion!,
        callbacks: {
          onUser: (msg) => writeEvent("user", msg),
          onTarget: (employee) => writeEvent("target", { employee }),
          onWorking: (msg) => writeEvent("working", msg),
          onChunk: (text) => writeEvent("chunk", { text }),
          onAssistant: (msg) => writeEvent("assistant", msg),
        },
      });
      writeEvent("done", {});
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (e) {
      if (!res.writableEnded && !res.destroyed) {
        writeEvent("error", {
          message: e instanceof Error ? e.message : String(e),
        });
        writeEvent("done", {});
        res.end();
      } else if (!res.destroyed) {
        next(e);
      }
    } finally {
      clearInterval(heartbeat);
    }
  },
);
