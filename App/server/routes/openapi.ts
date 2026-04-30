import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "../openapi/spec.js";

/**
 * Public API documentation surface.
 *
 * - `GET /api/openapi.json` — raw OpenAPI 3.0 document, consumable by tooling
 *   (Postman, openapi-generator, etc.).
 * - `GET /api/docs` — interactive Swagger UI bound to the spec, with the
 *   "Authorize" affordance pre-configured for both Bearer (M14 API keys)
 *   and the cookie session.
 *
 * Both endpoints are unauthenticated. The spec describes endpoint *shapes*
 * (paths, params, response schemas) — it doesn't leak data, and gating it
 * behind auth makes the SDK / tooling story worse without meaningfully
 * improving security. Callers still need a valid token to actually hit any
 * of the documented endpoints.
 */
export const openapiRouter = Router();

openapiRouter.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiDocument());
});

openapiRouter.use(
  "/docs",
  swaggerUi.serveFiles(undefined, {
    swaggerOptions: {
      url: "/api/openapi.json",
      // Persist the user's last "Authorize" entry across reloads so try-it-out
      // doesn't ask for the Bearer token on every refresh.
      persistAuthorization: true,
      // Show the docs page collapsed by default so users see the high-level
      // tag groupings (Auth / Companies / API Keys / …) before drilling in.
      docExpansion: "list",
    },
    customSiteTitle: "Genosyn API",
  }),
  swaggerUi.setup(undefined, {
    swaggerOptions: {
      url: "/api/openapi.json",
      persistAuthorization: true,
      docExpansion: "list",
    },
    customSiteTitle: "Genosyn API",
  }),
);
