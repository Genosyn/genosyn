import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";

import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import {
  auditBoardLetterAgain,
  getBoardLetter,
  getBoardLetterSettings,
  listBoardLetters,
  serializeBoardLetterSummary,
  updateBoardLetterSettings,
  writeBoardLetterNow,
} from "../services/boardLetters.js";

/**
 * Letters to the board: the monthly letter, its writer, and its auditor.
 *
 * Every route is owner/admin-only, reads included. The board in Genosyn today
 * is a company's owners and admins, a letter is addressed to them, and it
 * carries the company's money figures, which a Member's Finance access may not
 * allow. There is deliberately no route that edits or deletes a letter, and no
 * MCP tool behind any of these: the AI Employees can neither appoint their own
 * auditor nor touch what it concluded.
 */
export const boardLettersRouter = Router({ mergeParams: true });
boardLettersRouter.use(requireAuth);
boardLettersRouter.use(requireCompanyMember);
// Scoped to this router's own paths: several company routers share the mount.
boardLettersRouter.use(
  onRoutePaths(["/board-letters", /^\/board-letters\//], requireCompanyRole("admin")),
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
      if (status >= 400 && status < 500) {
        res.status(status).json({
          error: error instanceof Error ? error.message : "Letter request failed.",
        });
        return;
      }
      next(error);
    });
  };
}

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();

const letterParamsSchema = z
  .object({ cid: z.string().uuid(), number: z.coerce.number().int().min(1).max(1_000_000) })
  .strict();

const settingsBodySchema = z
  .object({
    enabled: z.boolean(),
    writerEmployeeId: z.string().uuid().nullable(),
    auditorEmployeeId: z.string().uuid().nullable(),
  })
  .strict();

const emptyBodySchema = z.object({}).strict().default({});

function letterNumber(req: Request): number {
  return (req.params as unknown as z.infer<typeof letterParamsSchema>).number;
}

boardLettersRouter.get(
  "/board-letters",
  validateParams(companyParamsSchema),
  h(async (req, res) => {
    const [settings, letters] = await Promise.all([
      getBoardLetterSettings(cid(req)),
      listBoardLetters(cid(req)),
    ]);
    res.json({ settings, letters });
  }),
);

boardLettersRouter.get(
  "/board-letters/settings",
  validateParams(companyParamsSchema),
  h(async (req, res) => {
    res.json(await getBoardLetterSettings(cid(req)));
  }),
);

boardLettersRouter.put(
  "/board-letters/settings",
  validateParams(companyParamsSchema),
  validateBody(settingsBodySchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof settingsBodySchema>;
    res.json(await updateBoardLetterSettings(cid(req), body, req.userId!));
  }),
);

boardLettersRouter.post(
  "/board-letters/write",
  validateParams(companyParamsSchema),
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    // Writing takes minutes, so the request returns once the letter is
    // claimed; the page follows it to the end through live updates.
    const { letter } = await writeBoardLetterNow(cid(req), req.userId!);
    res.status(202).json(serializeBoardLetterSummary(letter));
  }),
);

boardLettersRouter.get(
  "/board-letters/:number",
  validateParams(letterParamsSchema),
  h(async (req, res) => {
    res.json(await getBoardLetter(cid(req), letterNumber(req)));
  }),
);

boardLettersRouter.post(
  "/board-letters/:number/audit",
  validateParams(letterParamsSchema),
  validateBody(emptyBodySchema),
  h(async (req, res) => {
    const { letter } = await auditBoardLetterAgain(cid(req), letterNumber(req), req.userId!);
    res.status(202).json(serializeBoardLetterSummary(letter));
  }),
);
