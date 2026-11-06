import { Router, type Response } from "express";
import { z } from "zod";

import { INPUT_REQUEST_ANSWER_CHARS } from "../../shared/inputRequests.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import {
  InputRequestError,
  answerInputRequest,
  declineInputRequest,
  getInputRequest,
  listOpenInputRequests,
  readyInputRequest,
  viewsOf,
  type InputRequestActor,
} from "../services/inputRequests.js";

/**
 * Input requests: what AI Employees are waiting on people for
 * (`services/inputRequests.ts`).
 *
 * Reading follows the row: whoever was asked, and the owners and admins who can step
 * in. Anyone else reads as if there's nothing there, since a title can name a site
 * they have no business knowing the company signs in to.
 *
 * Answering takes a person in a browser. It isn't that a key could do damage so much
 * as that a key is what an AI Employee could hold, and something that answers its own
 * request for a person's code has defeated the only reason to ask. So every answer
 * refuses a bearer credential, and no AI tool reaches these routes.
 */
export const inputRequestsRouter = Router({ mergeParams: true });
inputRequestsRouter.use(requireAuth);
inputRequestsRouter.use(requireCompanyMember);

const idParamsSchema = z.object({ cid: z.string().min(1), id: z.string().uuid() }).strict();

const listQuerySchema = z
  .object({
    runId: z.string().uuid().optional(),
    todoId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();

const readySchema = z.object({}).strict();

const answerSchema = z
  .object({
    /**
     * A code, for a page waiting on one, or words, for a question. Left out for a step
     * a person has just done by hand.
     */
    value: z
      .string()
      .max(INPUT_REQUEST_ANSWER_CHARS + 1)
      .optional(),
  })
  .strict();

const declineSchema = z
  .object({ note: z.string().max(INPUT_REQUEST_ANSWER_CHARS).optional() })
  .strict();

type Handler<T> = () => Promise<T>;

function actorOf(req: { userId?: string; companyRole?: unknown }): InputRequestActor {
  return { userId: req.userId!, role: req.companyRole as InputRequestActor["role"] };
}

/** One response shape, and nothing that goes wrong here ever quotes a value back. */
async function respond<T>(res: Response, work: Handler<T>): Promise<Response> {
  // A person's answer, on its way through, is nothing a cache should hold.
  res.setHeader("Cache-Control", "no-store");
  try {
    return res.json(await work());
  } catch (error) {
    if (error instanceof InputRequestError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    // eslint-disable-next-line no-console
    console.error(
      "[input-requests] request failed:",
      error instanceof Error ? error.name : "error",
    );
    return res.status(500).json({ error: "Something went wrong. Nothing was sent to the page." });
  }
}

inputRequestsRouter.get("/input-requests", validateQuery(listQuerySchema), async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const work = listQuerySchema.parse(req.query);
  return respond(res, () => listOpenInputRequests({ companyId: cid, actor: actorOf(req), work }));
});

inputRequestsRouter.get("/input-requests/:id", validateParams(idParamsSchema), async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  return respond(res, () => getInputRequest({ companyId: cid, id, actor: actorOf(req) }));
});

/** "I'm ready." The work comes back, signs in again, and asks. */
inputRequestsRouter.post(
  "/input-requests/:id/ready",
  requireBrowserSession,
  validateParams(idParamsSchema),
  validateBody(readySchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const actor = actorOf(req);
    return respond(res, async () => {
      const row = await readyInputRequest({ companyId: cid, id, actor });
      return (await viewsOf([row], cid, actor))[0];
    });
  },
);

/** A code for a waiting page, words for a question, or "done" for a step by hand. */
inputRequestsRouter.post(
  "/input-requests/:id/answer",
  requireBrowserSession,
  validateParams(idParamsSchema),
  validateBody(answerSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const { value } = req.body as z.infer<typeof answerSchema>;
    const actor = actorOf(req);
    return respond(res, async () => {
      const row = await answerInputRequest({ companyId: cid, id, actor, value });
      return (await viewsOf([row], cid, actor))[0];
    });
  },
);

/** "I can't." The work is told, and goes on without it. */
inputRequestsRouter.post(
  "/input-requests/:id/decline",
  requireBrowserSession,
  validateParams(idParamsSchema),
  validateBody(declineSchema),
  async (req, res) => {
    const { cid, id } = req.params as Record<string, string>;
    const { note } = req.body as z.infer<typeof declineSchema>;
    const actor = actorOf(req);
    return respond(res, async () => {
      const row = await declineInputRequest({ companyId: cid, id, actor, note });
      return (await viewsOf([row], cid, actor))[0];
    });
  },
);
