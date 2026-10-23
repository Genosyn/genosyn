import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * Shared OpenAPI registry for the hand-written pages. Per-area files
 * (`auth.ts`, `apiKeys.ts`, …) call `registry.registerPath(...)` at module
 * load, and `document.ts` merges them into the generated document.
 *
 * `extendZodWithOpenApi(z)` monkeypatches the imported `z` with an `.openapi(...)`
 * method used to attach schema names + descriptions. Done once at module load.
 *
 * **Coverage.** Every route the App serves is documented without a page here:
 * `document.ts` reads the router stack, the zod schemas each route validates
 * with, and its guards. A hand-written page is for what the router cannot
 * know — prose, response schemas, examples — and wins over the generated
 * description for its route, except for access, which always comes from the
 * guards that run. Adding one = a file under `server/openapi/` that registers
 * its paths, imported in `document.ts`.
 */
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// Authentication schemes shared across every endpoint. Most endpoints accept
// either: (1) the cookie set by /api/auth/login (browser UI), or (2) a Bearer
// API key minted at /c/:slug/settings/api-keys (M14). Bearer auth is scoped
// to the company the key was minted for.
registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "gen_<43char-base64url>",
  description:
    "Per-user API key minted at Settings → API keys. The token authenticates as " +
    "its owning user but only unlocks the company it was minted for.",
});

registry.registerComponent("securitySchemes", "cookieAuth", {
  type: "apiKey",
  in: "cookie",
  name: "genosyn.sid",
  description:
    "Browser session cookie set by password, SSO, or passkey sign-in. Used by the web UI; " +
    "API clients should prefer Bearer auth.",
});

/** Default auth requirement applied to every registered path that doesn't
 * override `security` itself. Both schemes are accepted (OR, not AND).
 *
 * Typed as `Record<string, string[]>[]` (the OpenAPI shape) so the literal
 * elements don't narrow into a discriminated union and trip the index
 * signature check.
 */
export const defaultSecurity: Record<string, string[]>[] = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

/** Used for endpoints that don't require auth (login, signup, public webhooks). */
export const publicSecurity: Record<string, string[]>[] = [];
