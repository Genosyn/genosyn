import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { createBroker } from "./broker.js";
import type { ConnectConfig } from "./config.js";
import type { FlowStates } from "./flowState.js";
import { consoleLogger, type Logger } from "./log.js";
import { landingPage, LOGO_SVG, messagePage } from "./pages.js";
import { canonicalProtocol, LEGACY_GOOGLE_PROTOCOL, PROVIDER_ID_PATTERN } from "./protocol.js";
import type { ProviderRegistry } from "./providers/index.js";
import { offeredScopes } from "./providers/types.js";
import { createProtocolRouter } from "./routes.js";
import { Throttle } from "./throttle.js";

export type ConnectAppOptions = {
  config: Pick<ConnectConfig, "publicUrl" | "trustedProxyHops" | "accessLog" | "links">;
  flows: FlowStates;
  providers: ProviderRegistry;
  throttle?: Throttle;
  log?: Logger;
};

/**
 * The whole public surface: a landing page, health checks, a discovery
 * index, and each provider's protocol routes. Nothing else answers.
 */
export function createConnectApp(options: ConnectAppOptions): express.Express {
  const { config, flows, providers } = options;
  const throttle = options.throttle ?? new Throttle();
  const log = options.log ?? consoleLogger;
  const https = config.publicUrl.startsWith("https://");
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // Only the operator knows how many proxies sit in front; the client address
  // the limiter sees is the one that many hops back.
  app.set("trust proxy", config.trustedProxyHops > 0 ? config.trustedProxyHops : false);

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });

  if (config.accessLog) {
    app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      // The path only: query strings carry authorization codes and states.
      const path = req.path;
      res.on("finish", () => {
        const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
        log.info(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
      });
      next();
    });
  }

  const styleNonce = () => crypto.randomBytes(18).toString("base64url");
  function pagePolicy(res: Response, nonce: string) {
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; img-src 'self'; style-src 'nonce-${nonce}'`,
    );
  }

  app.get("/", (_req, res) => {
    const nonce = styleNonce();
    pagePolicy(res, nonce);
    res.type("html").send(
      landingPage({
        providers: [...providers.values()].map((provider) => ({
          name: provider.name,
          products: provider.registration ? provider.groups.map((group) => group.label) : [],
        })),
        styleNonce: nonce,
        links: config.links,
      }),
    );
  });

  app.get("/favicon.svg", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/svg+xml").send(LOGO_SVG);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await flows.store.ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get("/api/connect", (_req, res) => {
    res.json({
      version: 1,
      providers: [...providers.values()].map((provider) => {
        const available = Boolean(provider.registration) && provider.groups.length > 0;
        return {
          id: provider.id,
          name: provider.name,
          available,
          scopes: available ? offeredScopes(provider) : [],
          groups: available
            ? provider.groups.map(({ key, label, scopes }) => ({ key, label, scopes }))
            : [],
        };
      }),
    });
  });

  const brokerOptions = { publicUrl: config.publicUrl, flows };
  const routerOptions = { publicUrl: config.publicUrl, throttle, links: config.links };
  const canonical = new Map(
    [...providers.values()].map((provider) => [
      provider.id,
      createProtocolRouter(
        createBroker(provider, canonicalProtocol(provider.id), brokerOptions),
        routerOptions,
      ),
    ]),
  );
  app.use("/api/connect/:provider", (req, res, next) => {
    const id = req.params.provider ?? "";
    const router = PROVIDER_ID_PATTERN.test(id) ? canonical.get(id) : undefined;
    if (!router) return res.status(404).json({ error: "Sign-in provider not found" });
    return router(req, res, next);
  });

  const google = providers.get("google");
  if (google) {
    app.use(
      LEGACY_GOOGLE_PROTOCOL.basePath,
      createProtocolRouter(
        createBroker(google, LEGACY_GOOGLE_PROTOCOL, brokerOptions),
        routerOptions,
      ),
    );
  }

  // Browsers ask for HTML; installations ask for JSON.
  const wantsPage = (req: Request) => req.accepts(["json", "html"]) === "html";

  app.use((req, res) => {
    if (!wantsPage(req)) return res.status(404).json({ error: "Not found" });
    const nonce = styleNonce();
    pagePolicy(res, nonce);
    res
      .status(404)
      .type("html")
      .send(
        messagePage({
          title: "Page not found",
          detail: "Return to your Genosyn installation to connect an Integration.",
          tone: "info",
          styleNonce: nonce,
          links: config.links,
        }),
      );
  });

  // Unexpected failures are logged by name only: their messages can quote a
  // database row or an upstream response.
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    log.error(
      `${req.method} ${req.path} failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    if (res.headersSent) return next(error);
    if (!wantsPage(req)) {
      return res.status(500).json({ error: "Sign-in failed. Please try again." });
    }
    const nonce = styleNonce();
    pagePolicy(res, nonce);
    res
      .status(500)
      .type("html")
      .send(
        messagePage({
          title: "Sign-in could not continue",
          detail: "Something went wrong. Return to your Genosyn installation and try again.",
          tone: "error",
          styleNonce: nonce,
          links: config.links,
        }),
      );
  });

  return app;
}
