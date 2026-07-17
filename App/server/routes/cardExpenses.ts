import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
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
  res.json(await listCardTransactions(params.data.cid, query.data.feedId));
});

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
