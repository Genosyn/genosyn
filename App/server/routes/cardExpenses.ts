import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import { validateBody } from "../middleware/validate.js";
import {
  CardCategoryFixError,
  cardCategoryFixesToReview,
  fixSplitCardCategory,
} from "../services/cardCategoryRepair.js";
import {
  createCardFeed,
  deleteEmptyCardFeed,
  listCardTransactions,
  loadCardFeed,
  reclassifyCardTransaction,
  retryCardTransaction,
  syncCardFeed,
} from "../services/cardExpenses.js";

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

cardExpensesRouter.post("/card-feeds/:feedId/sync", async (req, res) => {
  const params = feedParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid card feed id" });
  }
  const feed = await loadCardFeed(params.data.cid, params.data.feedId);
  if (!feed) return res.status(404).json({ error: "Card feed not found" });
  try {
    res.json(await syncCardFeed(feed));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

cardExpensesRouter.delete("/card-feeds/:feedId", async (req, res) => {
  const params = feedParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid card feed id" });
  }
  const feed = await loadCardFeed(params.data.cid, params.data.feedId);
  if (!feed) return res.status(404).json({ error: "Card feed not found" });
  try {
    await deleteEmptyCardFeed(feed);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

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
