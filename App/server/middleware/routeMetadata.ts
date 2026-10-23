import type { ZodTypeAny } from "zod";
import type { Role } from "../db/entities/Membership.js";

/**
 * What a middleware factory knows about the request it guards, attached to the
 * function it returns.
 *
 * The OpenAPI document is generated from the live router stack
 * (`server/openapi/routeDiscovery.ts`), and a function on that stack is all it
 * gets to look at. `validateBody(schema)` returns an anonymous closure; without
 * this, the schema it enforces — the most accurate description of the request
 * there is — would be invisible. The same goes for the role a
 * `requireCompanyRole("admin")` closure demands, or the paths an
 * `onRoutePaths(...)` guard is scoped to.
 *
 * It costs nothing at request time: the middleware never reads its own
 * metadata, and the property is non-enumerable, so nothing else sees it either.
 */

/** The request locations a zod validator can stand guard over. */
export type RequestSchemaLocation = "body" | "query" | "params";

export type RouteMetadata =
  | {
      /** `validateBody` / `validateQuery` / `validateParams`. */
      kind: "requestSchema";
      location: RequestSchemaLocation;
      schema: ZodTypeAny;
    }
  | {
      /** `requireCompanyRole(minimum)` / `requireCompanyRoleForMutations(minimum)`. */
      kind: "companyRole";
      minimum: Role;
      /** True when reads pass and only mutations need the role. */
      mutationsOnly: boolean;
    }
  | {
      /** `onRoutePaths(matchers, middleware)`: the guard runs only on matching paths. */
      kind: "pathScoped";
      matchers: readonly (string | RegExp)[];
      middleware: unknown;
    }
  | {
      /**
       * A guard that demands a signed-in browser session only for some requests
       * to an otherwise API-key-friendly route — assigning a todo to an AI
       * Employee, say. `when` finishes the sentence "A browser session is
       * required …".
       */
      kind: "conditionalBrowserSession";
      when: string;
    }
  | {
      /**
       * A router's own guard that refuses every API key, as
       * `requireBrowserSession` does, but with its own message or alongside
       * other work.
       */
      kind: "browserSessionOnly";
    };

const ROUTE_METADATA = Symbol.for("genosyn.routeMetadata");

/** Attach `metadata` to `fn` and return `fn` itself, so a factory can `return withRouteMetadata(...)`. */
export function withRouteMetadata<T extends object>(fn: T, metadata: RouteMetadata): T {
  Object.defineProperty(fn, ROUTE_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return fn;
}

/** The metadata attached to `fn`, if any. Safe to call on anything. */
export function routeMetadataOf(fn: unknown): RouteMetadata | undefined {
  if ((typeof fn !== "function" && typeof fn !== "object") || fn === null) return undefined;
  return (fn as { [ROUTE_METADATA]?: RouteMetadata })[ROUTE_METADATA];
}

/**
 * Mark a guard that calls `requireBrowserSession` only under some condition, so
 * the API reference can say when an API key is refused instead of claiming it
 * always works (or never does).
 */
export function describeBrowserSessionCondition<T extends object>(fn: T, when: string): T {
  return withRouteMetadata(fn, { kind: "conditionalBrowserSession", when });
}

/** Mark a hand-written guard that refuses every API key, so the reference says so. */
export function describeBrowserSessionOnly<T extends object>(fn: T): T {
  return withRouteMetadata(fn, { kind: "browserSessionOnly" });
}
