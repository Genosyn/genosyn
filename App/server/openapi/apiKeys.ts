import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

/**
 * M14 — API keys. The headline endpoints documented here are the canonical
 * scripting surface: list your keys, mint a new one (which returns the
 * plaintext exactly once), revoke. Bearer-authenticated requests are
 * forbidden from minting new keys (chain-of-custody).
 */

const ApiKey = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    prefix: z.string().describe(
      "Display-only chip including the `gen_` prefix and the first 8 chars of the random suffix.",
    ),
    lastUsedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("ApiKey");

const ApiKeyCreated = ApiKey.extend({
  token: z
    .string()
    .describe(
      "Plaintext token. Returned exactly once on create — never persisted or shown again. " +
        "Pass as `Authorization: Bearer <token>`.",
    ),
}).openapi("ApiKeyCreated");

const ApiKeyCreateRequest = z
  .object({
    name: z.string().min(1).max(100),
    expiresAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .describe("Optional ISO-8601 expiry. Past dates rejected."),
  })
  .openapi("ApiKeyCreateRequest");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

const cidParam = z.object({ cid: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/api-keys",
  summary: "List your API keys for a company",
  description:
    "Returns the calling user's API keys (including revoked / expired) for the given " +
    "company. Plaintext tokens are never returned by this endpoint.",
  tags: ["API Keys"],
  security: defaultSecurity,
  request: { params: cidParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(ApiKey) } },
    },
    401: { description: "Not authenticated", content: { "application/json": { schema: ErrorResponse } } },
    403: { description: "Not a member of this company", content: { "application/json": { schema: ErrorResponse } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/api-keys",
  summary: "Generate a new API key",
  description:
    "Mints a new API key for the calling user, scoped to this company. The plaintext " +
    "token is returned in the `token` field exactly once — store it immediately. " +
    "Forbidden if the request itself is authenticated with a Bearer token (chain-of-custody " +
    "invariant: API keys can only be minted from a logged-in browser session).",
  tags: ["API Keys"],
  security: defaultSecurity,
  request: {
    params: cidParam,
    body: { content: { "application/json": { schema: ApiKeyCreateRequest } } },
  },
  responses: {
    200: {
      description: "Created",
      content: { "application/json": { schema: ApiKeyCreated } },
    },
    400: { description: "Invalid expiresAt", content: { "application/json": { schema: ErrorResponse } } },
    403: {
      description: "Bearer-authenticated request, or wrong company",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{cid}/api-keys/{id}",
  summary: "Revoke an API key",
  description:
    "Soft-revokes the key (sets `revokedAt`). Subsequent Bearer requests using this " +
    "token return 401. Idempotent — revoking an already-revoked key is a no-op.",
  tags: ["API Keys"],
  security: defaultSecurity,
  request: {
    params: z.object({
      cid: z.string().uuid(),
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: "Revoked", content: { "application/json": { schema: ApiKey } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
  },
});
