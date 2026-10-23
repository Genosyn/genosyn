import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { buildOpenApiDocument } from "../openapi/spec.js";

/**
 * Public API documentation surface.
 *
 * - `GET /api/openapi.json` — the OpenAPI 3.0 document for every endpoint the
 *   App serves, read off the very app answering the request, consumable by
 *   tooling (Postman, openapi-generator, an MCP server, etc.).
 * - `GET /api/docs` — Swagger UI bound to the spec, grouped by product area,
 *   with a search box and the "Authorize" affordance for both Bearer (API
 *   keys) and the cookie session.
 *
 * Both endpoints are unauthenticated. The spec describes endpoint *shapes*
 * (paths, params, response schemas) — it doesn't leak data, and gating it
 * behind auth makes the SDK / tooling story worse without meaningfully
 * improving security. Callers still need a valid token to actually hit any
 * of the documented endpoints.
 */
export const openapiRouter = Router();

openapiRouter.get("/openapi.json", (req, res) => {
  res.json(buildOpenApiDocument(req.app));
});

/**
 * Genosyn's own Swagger UI initializer, loaded after swagger-ui-express's and
 * replacing its `window.onload`. It exists for one plugin options alone cannot
 * carry — swagger-ui-express serializes function options as source, which tsx
 * rewrites — a search that matches what people look for in a reference this
 * size: an area, a path, a summary or an operation id, ignoring case. Swagger
 * UI's own filter matches area names only, and only in the same case.
 */
const DOCS_SCRIPT = `(function () {
  "use strict";
  function text(value) { return value ? String(value).toLowerCase() : ""; }
  function operationMatches(op, needle) {
    var operation = op.get("operation");
    var haystack = [
      op.get("method"),
      op.get("path"),
      operation && operation.get("summary"),
      operation && operation.get("operationId"),
    ].map(text).join(" ");
    return haystack.indexOf(needle) !== -1;
  }
  function GenosynSearch() {
    return {
      fn: {
        opsFilter: function (taggedOps, phrase) {
          var needle = text(phrase).trim();
          if (!needle) return taggedOps;
          return taggedOps
            .map(function (group, tag) {
              if (text(tag).indexOf(needle) !== -1) return group;
              return group.update("operations", function (ops) {
                return ops.filter(function (op) { return operationMatches(op, needle); });
              });
            })
            .filter(function (group) { return group.get("operations").size > 0; });
        },
      },
    };
  }
  function labelSearch() {
    var input = document.querySelector(".operation-filter-input");
    if (!input) return false;
    input.placeholder = "Search areas, paths, summaries and operation ids";
    input.setAttribute("aria-label", "Search the API reference");
    return true;
  }
  window.onload = function () {
    window.ui = SwaggerUIBundle({
      url: "/api/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      plugins: [SwaggerUIBundle.plugins.DownloadUrl, GenosynSearch],
      layout: "StandaloneLayout",
      docExpansion: "none",
      filter: true,
      displayOperationId: true,
      defaultModelsExpandDepth: -1,
      displayRequestDuration: true,
      persistAuthorization: true,
    });
    if (!labelSearch()) {
      var observer = new MutationObserver(function () {
        if (labelSearch()) observer.disconnect();
      });
      observer.observe(document.getElementById("swagger-ui"), { childList: true, subtree: true });
    }
  };
})();
`;

openapiRouter.get("/docs/genosyn-docs.js", (_req, res) => {
  res.type("application/javascript").send(DOCS_SCRIPT);
});

openapiRouter.use(
  "/docs",
  swaggerUi.serveFiles(undefined, { swaggerOptions: { url: "/api/openapi.json" } }),
  swaggerUi.setup(undefined, {
    swaggerOptions: { url: "/api/openapi.json" },
    customSiteTitle: "Genosyn API",
    customJs: "./genosyn-docs.js",
  }),
);
