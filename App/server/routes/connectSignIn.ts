import { Router } from "express";
import { z } from "zod";
import { createSignInBroker } from "../services/signInBroker.js";
import { canonicalSignInProtocol } from "../services/signInBrokerProtocol.js";
import { getSignInProvider } from "../services/signInProviders/index.js";
import { createSignInBrokerRouter } from "./signInBrokerRouter.js";

/** The connect host exposes only registered adapters, never the App UI. */
export const connectSignInRouter = Router();
const providerSchema = z.object({ provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict();
const routers = new Map<string, ReturnType<typeof createSignInBrokerRouter>>();
connectSignInRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
connectSignInRouter.use("/:provider", (req, res, next) => {
  const parsed = providerSchema.safeParse(req.params);
  const provider = parsed.success ? getSignInProvider(parsed.data.provider) : undefined;
  if (!provider) return res.status(404).json({ error: "Sign-in provider not found" });
  let router = routers.get(provider.id);
  if (!router) {
    router = createSignInBrokerRouter(
      createSignInBroker(provider, canonicalSignInProtocol(provider.id)),
    );
    routers.set(provider.id, router);
  }
  return router(req, res, next);
});
connectSignInRouter.use((_req, res) =>
  res.status(404).json({ error: "Sign-in endpoint not found" }),
);
