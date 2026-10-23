import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { BankingAccountError, changeFeedConnection } from "../services/banking.js";
import {
  FeedBusyError,
  FeedNotFoundError,
  syncFeedForRequest,
  syncResponse,
  whileFeedIdle,
} from "../services/bankingSync.js";
import {
  CardCategoryFixError,
  cardCategoryFixesToReview,
  fixSplitCardCategory,
} from "../services/cardCategoryRepair.js";
import {
  CardFeedInUseError,
  createCardFeed,
  deleteEmptyCardFeed,
  listCardTransactions,
  loadCardFeed,
  reclassifyCardTransaction,
  retryCardTransaction,
} from "../services/cardExpenses.js";
import { FeedSyncError } from "../services/feedSyncErrors.js";

export const cardExpensesRouter = Router({ mergeParams: true });
cardExpensesRouter.use(requireAuth);
cardExpensesRouter.use(requireCompanyMember);

// Same per-member finance gate as financeRouter — card expenses post to the
// ledger, so they are finance too. Wrapping the verb methods keeps the guard on
// matched card-expense routes only, never the sibling routers on this mount.
for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
  const original = cardExpensesRouter[verb].bind(cardExpensesRouter) as (
    path: string,
    ...handlers: RequestHandler[]
  ) => unknown;
  (cardExpensesRouter as unknown as Record<string, typeof original>)[verb] = (
    path: string,
    ...handlers: RequestHandler[]
  ) => original(path, verb === "get" ? requireFinanceRead : requireFinanceWrite, ...handlers);
}

const companyParamsSchema = z.object({
  cid: z.string().uuid(),
});
const feedParamsSchema = companyParamsSchema.extend({
  feedId: z.string().uuid(),
});
const transactionParamsSchema = companyParamsSchema.extend({
  transactionId: z.string().uuid(),
});
const transactionQuerySchema = z.object({
  feedId: z.string().uuid().optional(),
  status: z.enum(["review", "done"]).optional(),
});
const cardFeedCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().uuid(),
  liabilityAccountId: z.string().uuid(),
  defaultExpenseAccountId: z.string().uuid(),
  paymentAccountId: z.string().uuid(),
});
const categorySchema = z.object({
  expenseAccountId: z.string().uuid(),
});
const feedConnectionSchema = z.object({
  connectionId: z.string().uuid(),
});
/** The correcting entry the person was shown, which the fix must still match. */
const fixCategorySchema = z.object({
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debitCents: z.number().int().nonnegative(),
        creditCents: z.number().int().nonnegative(),
      }),
    )
    .min(2)
    .max(50),
});

cardExpensesRouter.get("/card-feeds", async (req, res) => {
  const params = companyParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid company id" });
  }
  const feeds = await AppDataSource.getRepository(CardFeed).find({
    where: { companyId: params.data.cid },
    order: { createdAt: "ASC" },
  });
  res.json(feeds);
});

cardExpensesRouter.post("/card-feeds", validateBody(cardFeedCreateSchema), async (req, res) => {
  const params = companyParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid company id" });
  }
  const body = req.body as z.infer<typeof cardFeedCreateSchema>;
  try {
    res.json(
      await createCardFeed({
        companyId: params.data.cid,
        ...body,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Sync the card now, exactly as the background sync does: 200 with what came
// in, 400 with why it failed (the card keeps saying so on Banking), 202 when
// it is still running after twenty seconds and carries on.
cardExpensesRouter.post(
  "/card-feeds/:feedId/sync",
  validateParams(feedParamsSchema),
  async (req, res, next) => {
    const { cid, feedId } = req.params as unknown as z.infer<typeof feedParamsSchema>;
    try {
      const { status, body } = syncResponse(
        await syncFeedForRequest({ kind: "card", companyId: cid, id: feedId }),
      );
      res.status(status).json(body);
    } catch (err) {
      if (err instanceof FeedNotFoundError) {
        return res.status(404).json({ error: "Card feed not found" });
      }
      if (err instanceof FeedSyncError) return res.status(400).json({ error: err.message });
      next(err);
    }
  },
);

// Point the card at another Brex Connection — the way back for one whose
// Connection was removed. The next sync runs at once.
cardExpensesRouter.patch(
  "/card-feeds/:feedId",
  validateParams(feedParamsSchema),
  validateBody(feedConnectionSchema),
  async (req, res, next) => {
    const { cid, feedId } = req.params as unknown as z.infer<typeof feedParamsSchema>;
    const body = req.body as z.infer<typeof feedConnectionSchema>;
    try {
      const feed = await loadCardFeed(cid, feedId);
      if (!feed) return res.status(404).json({ error: "Card feed not found" });
      res.json(
        await whileFeedIdle({ kind: "card", companyId: cid, id: feedId }, () =>
          changeFeedConnection("card", feed, body.connectionId),
        ),
      );
    } catch (err) {
      if (err instanceof FeedBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof BankingAccountError) return res.status(400).json({ error: err.message });
      next(err);
    }
  },
);

cardExpensesRouter.delete(
  "/card-feeds/:feedId",
  validateParams(feedParamsSchema),
  async (req, res, next) => {
    const { cid, feedId } = req.params as unknown as z.infer<typeof feedParamsSchema>;
    try {
      const feed = await loadCardFeed(cid, feedId);
      if (!feed) return res.status(404).json({ error: "Card feed not found" });
      // Never under a sync, which may be putting its first purchases in the books.
      await whileFeedIdle({ kind: "card", companyId: cid, id: feedId }, () =>
        deleteEmptyCardFeed(feed),
      );
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof FeedBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof CardFeedInUseError) return res.status(409).json({ error: err.message });
      next(err);
    }
  },
);

cardExpensesRouter.get("/card-transactions", async (req, res) => {
  const params = companyParamsSchema.safeParse(req.params);
  const query = transactionQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    return res.status(400).json({ error: "Invalid card transaction query" });
  }
  res.json(await listCardTransactions(params.data.cid, query.data.feedId, query.data.status));
});

// Card purchases whose books no longer match the category Banking shows, from
// before Banking was the one place it changes, that need a person to fix.
cardExpensesRouter.get("/card-transactions/category-drift", async (req, res) => {
  const params = companyParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid company id" });
  }
  res.json(await cardCategoryFixesToReview(params.data.cid));
});

cardExpensesRouter.post(
  "/card-transactions/:transactionId/fix-category",
  validateBody(fixCategorySchema),
  async (req, res) => {
    const params = transactionParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: "Invalid card transaction id" });
    }
    try {
      res.json(
        await fixSplitCardCategory({
          companyId: params.data.cid,
          transactionId: params.data.transactionId,
          lines: (req.body as z.infer<typeof fixCategorySchema>).lines,
          actorUserId: req.userId ?? null,
        }),
      );
    } catch (err) {
      const status = err instanceof CardCategoryFixError ? err.status : 400;
      res.status(status).json({ error: (err as Error).message });
    }
  },
);

cardExpensesRouter.patch(
  "/card-transactions/:transactionId/category",
  validateBody(categorySchema),
  async (req, res) => {
    const params = transactionParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: "Invalid card transaction id" });
    }
    const transaction = await AppDataSource.getRepository(CardTransaction).findOneBy({
      id: params.data.transactionId,
      companyId: params.data.cid,
    });
    if (!transaction) {
      return res.status(404).json({ error: "Card transaction not found" });
    }
    try {
      res.json(
        await reclassifyCardTransaction(
          transaction,
          (req.body as z.infer<typeof categorySchema>).expenseAccountId,
          req.userId ?? null,
        ),
      );
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

cardExpensesRouter.post("/card-transactions/:transactionId/retry", async (req, res) => {
  const params = transactionParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid card transaction id" });
  }
  const transaction = await AppDataSource.getRepository(CardTransaction).findOneBy({
    id: params.data.transactionId,
    companyId: params.data.cid,
  });
  if (!transaction) {
    return res.status(404).json({ error: "Card transaction not found" });
  }
  try {
    res.json(await retryCardTransaction(transaction));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
