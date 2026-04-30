import { z } from "zod";
import { defaultSecurity, registry } from "./registry.js";

const Company = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    role: z.enum(["owner", "admin", "member"]).optional(),
  })
  .openapi("Company");

const ErrorResponse = z.object({ error: z.string() }).openapi("Error");

registry.registerPath({
  method: "get",
  path: "/api/companies",
  summary: "List companies the current user is a member of",
  description:
    "Returns every company the authenticated user has access to. With Bearer " +
    "auth this returns exactly one company (the one the key was minted for).",
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
