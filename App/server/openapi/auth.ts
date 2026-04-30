import { z } from "zod";
import { defaultSecurity, publicSecurity, registry } from "./registry.js";

/**
 * Auth endpoints. Login + signup are public; everything else requires the
 * cookie or a Bearer token. Once you have a session cookie, you can mint a
 * Bearer token at Settings → API keys for use against this same surface.
 */

const MeResponse = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    name: z.string(),
    avatarKey: z.string().nullable(),
  })
  .openapi("Me");

const LoginRequest = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi("LoginRequest");

const ErrorResponse = z
  .object({ error: z.string() })
  .openapi("Error");

registry.registerPath({
  method: "get",
  path: "/api/auth/me",
  summary: "Get the authenticated user",
  description:
    "Returns the currently-authenticated user. Useful as a `whoami` probe to " +
    "confirm a Bearer token works before making real calls.",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: MeResponse } },
    },
    401: {
      description: "No valid session or Bearer token",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  summary: "Log in with email + password",
  description:
    "Sets the `genosyn.sid` session cookie. The cookie is required for the " +
    "web UI; programmatic clients should mint a Bearer API key instead.",
  tags: ["Auth"],
  security: publicSecurity,
  request: {
    body: {
      content: { "application/json": { schema: LoginRequest } },
    },
  },
  responses: {
    200: {
      description: "Logged in; sets the session cookie",
      content: { "application/json": { schema: MeResponse } },
    },
    401: {
      description: "Invalid credentials",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  summary: "Clear the session cookie",
  tags: ["Auth"],
  security: defaultSecurity,
  responses: {
    200: {
      description: "Logged out",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
  },
});
