import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

const Company = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    mission: z.string(),
    vision: z.string(),
    timezone: z
      .string()
      .describe(
        "IANA time zone (for example `Europe/Berlin`) that Routine schedules are read in. " +
          "Empty means server time.",
      ),
    role: z.enum(["owner", "admin", "member"]).optional(),
    requireTwoFactor: z.boolean(),
  })
  .openapi("Company");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

registry.registerPath({
  method: "get",
  path: "/api/companies",
  summary: "List companies the current user is a member of",
  description:
    "Returns every company the signed-in user belongs to. Browser-only: an API key " +
    "belongs to one company already, and `GET /api/companies/{cid}/me` names it.",
  tags: ["Companies"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(Company) } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

const CompanyMe = z
  .object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string(),
      name: z.string(),
      handle: z.string().nullable(),
    }),
    company: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
    role: z.enum(["owner", "admin", "member"]),
    financeAccess: z
      .enum(["none", "read", "full"])
      .describe("Owners and admins always have full Finance access."),
    authentication: z.enum(["api_key", "session"]).describe("How this request was authenticated."),
    apiKey: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        prefix: z.string().describe("`gen_` and the first characters of the token."),
        expiresAt: z.string().datetime().nullable(),
      })
      .nullable()
      .describe("The key this request used; null for a browser session."),
  })
  .openapi("CompanyMe");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/me",
  summary: "Who is calling, in this company",
  description:
    "The API's `whoami`: the Member the request acts as, their role and Finance access in " +
    "this company, and — for an API key — which key it was. Call it first to confirm a key " +
    "reaches the company you meant, as the Member you meant, before changing anything.",
  tags: ["Companies"],
  security: defaultSecurity,
  request: { params: z.object({ cid: z.string().uuid() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: CompanyMe } } },
    401: {
      description: "No valid session or API key",
      content: { "application/json": { schema: ErrorResponse } },
    },
    403: {
      description: "Not a Member of this company, or a key for another company",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});
