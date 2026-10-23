import { Router } from "express";

/**
 * Every route an Express app answers, read off its router stack.
 *
 * The API reference used to be a hand-maintained list, and it covered about a
 * hundred of the App's fifteen hundred endpoints. This module asks the router
 * itself instead: it walks the same stack Express dispatches through, so a
 * route cannot exist without appearing here, and a route that appears here is
 * one a request can actually reach.
 *
 * For each route it reports the method, the full path with every mount prefix,
 * and — by replaying Express's dispatch for a request to that path — every
 * middleware that runs before the handler, in order, along with the path that
 * middleware sees as `req.path`. That chain is what the OpenAPI generator reads
 * to find the route's zod schemas and authorization guards
 * (`middleware/routeMetadata.ts`), so the reference describes the checks the
 * server really performs rather than the ones someone remembered to write down.
 *
 * Express 4 keeps a route's own path (`layer.route.path`) but discards the
 * path a router was mounted at, leaving only the regular expression compiled
 * from it. {@link mountPathOf} turns that expression back into the path and
 * proves the round trip by compiling the result again with Express's own
 * `Layer`; a mount it cannot read is an error, not a guess.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

const HTTP_METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/** One middleware that runs before a route's own handlers. */
export type ChainLink = {
  handle: unknown;
  /** `req.path` as this middleware sees it: the request path below its mount. */
  path: string;
};

export type DiscoveredRoute = {
  method: HttpMethod;
  /** Express pattern including every mount prefix: `/api/companies/:cid/revenue/deals/:id`. */
  expressPath: string;
  /** OpenAPI path template: `/api/companies/{cid}/revenue/deals/{id}`. */
  path: string;
  /** Path parameter names, in the order they appear. */
  pathParams: string[];
  /** Middleware that runs before the route's own handlers, in dispatch order. */
  chain: ChainLink[];
  /** The route's own handlers — validators, guards, then the handler — in order. */
  handlers: unknown[];
  /** `req.path` as the route's own handlers see it. */
  routePath: string;
  /** Routers entered on the way to the route, outermost first. */
  routers: unknown[];
  /** A route registered earlier that answers this route's requests before it can. */
  shadowedBy?: string;
};

/** A route the walker found but could not describe, so it cannot be documented. */
export type UndocumentableRoute = {
  method: string;
  expressPath: string;
  reason: string;
};

export type RouteDiscovery = {
  routes: DiscoveredRoute[];
  undocumentable: UndocumentableRoute[];
};

/* ------------------------------------------------------------------------ */
/* Express internals, typed as far as this module relies on them.            */
/* ------------------------------------------------------------------------ */

type LayerRegExp = RegExp & { fast_slash?: boolean; fast_star?: boolean };

type ExpressLayer = {
  handle: ((...args: unknown[]) => unknown) & { stack?: ExpressLayer[] };
  regexp: LayerRegExp;
  keys: Array<{ name: string | number; optional?: boolean }>;
  method?: string;
  route?: ExpressRoute;
};

type ExpressRoute = {
  path: unknown;
  methods: Record<string, boolean>;
  stack: ExpressLayer[];
};

/** The root stack of an Express application, or of a bare Router. */
export function rootStackOf(app: unknown): ExpressLayer[] {
  const candidate = app as { _router?: { stack?: ExpressLayer[] }; stack?: ExpressLayer[] };
  return candidate._router?.stack ?? candidate.stack ?? [];
}

const routerCache = new WeakMap<object, boolean>();

function isRouter(handle: unknown): handle is { stack: ExpressLayer[] } {
  if (typeof handle !== "function") return false;
  let known = routerCache.get(handle);
  if (known === undefined) {
    const stack = (handle as unknown as { stack?: unknown }).stack;
    // A Router's stack holds Layers; anything else with a `stack` array is not one.
    known =
      Array.isArray(stack) &&
      stack.every((layer) => typeof layer === "object" && layer !== null && "regexp" in layer);
    routerCache.set(handle, known);
  }
  return known;
}

/** Mount paths never change once a layer exists, and replay asks for them per route. */
const mountPathCache = new WeakMap<object, string>();

function cachedMountPathOf(layer: ExpressLayer): string {
  let path = mountPathCache.get(layer);
  if (path === undefined) {
    path = mountPathOf(layer);
    mountPathCache.set(layer, path);
  }
  return path;
}

/* ------------------------------------------------------------------------ */
/* Mount paths                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Recover the path a router or middleware was mounted at from its compiled
 * expression. `app.use("/api/companies/:cid", router)` compiles (through
 * path-to-regexp 0.1) to `^\/api\/companies(?:\/([^/]+?))\/?(?=\/|$)`, and
 * this returns `/api/companies/:cid`. A root mount returns `""`.
 *
 * Throws when the expression is not one Express would have compiled from a
 * plain string path — a RegExp or array mount — or when the recovered path
 * does not compile back to the same expression.
 */
export function mountPathOf(layer: Pick<ExpressLayer, "regexp" | "keys">): string {
  if (layer.regexp.fast_slash) return "";
  if (layer.regexp.fast_star) throw new Error("A `*` mount has no path to document");
  const source = layer.regexp.source;
  const tail = "\\/?(?=\\/|$)";
  if (!source.startsWith("^") || !source.endsWith(tail)) {
    throw new Error(`Mount expression ${source} was not compiled from a string path`);
  }
  const body = source.slice(1, source.length - tail.length);
  const keys = layer.keys.map((key) => key.name);
  let keyIndex = 0;
  let out = "";
  for (let i = 0; i < body.length; ) {
    if (body.startsWith("(?:", i)) {
      const end = closingParen(body, i);
      const group = body.slice(i + 3, end);
      // A parameter compiles to `(?:` + `\/` (or `\.`) + one capturing group + `)`.
      const prefix = group.startsWith("\\/") ? "/" : group.startsWith("\\.") ? "." : "";
      const capture = prefix ? group.slice(2) : group;
      if (
        !capture.startsWith("(") ||
        capture.startsWith("(?") ||
        closingParen(capture, 0) !== capture.length - 1
      ) {
        throw new Error(`Mount expression ${source} has a group that is not a path parameter`);
      }
      const name = keys[keyIndex++];
      if (typeof name !== "string") {
        throw new Error(`Mount expression ${source} has an unnamed parameter`);
      }
      const optional = body[end + 1] === "?";
      out += `${prefix}:${name}${optional ? "?" : ""}`;
      i = end + 1 + (optional ? 1 : 0);
      continue;
    }
    if (body[i] === "\\") {
      out += body[i + 1];
      i += 2;
      continue;
    }
    if ("()[]*+?{}|^$".includes(body[i])) {
      throw new Error(
        `Mount expression ${source} uses ${body[i]}, which a plain path never compiles to`,
      );
    }
    out += body[i];
    i += 1;
  }
  if (keyIndex !== keys.length) {
    throw new Error(
      `Mount expression ${source} names ${keys.length} parameters but has ${keyIndex}`,
    );
  }
  // Prove it: Express must compile the recovered path to the very same expression.
  const probe = Router({ caseSensitive: !layer.regexp.flags.includes("i") });
  probe.use(out, () => undefined);
  const compiled = (probe as unknown as { stack: ExpressLayer[] }).stack[0].regexp;
  if (compiled.source !== source || compiled.flags !== layer.regexp.flags) {
    throw new Error(`Recovered mount path ${out} does not compile back to ${source}`);
  }
  return out;
}

/** Index of the parenthesis closing the one opened at `open`, honoring escapes and classes. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced parentheses in ${text}`);
}

/** Join mount prefixes and a route path the way a request URL would spell them. */
export function joinRoutePath(prefix: string, routePath: string): string {
  const joined = `${prefix}${routePath.startsWith("/") ? "" : "/"}${routePath}`.replace(
    /\/{2,}/g,
    "/",
  );
  return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
}

/** `/a/:b/c` → `/a/{b}/c`. */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Parameter names in an Express path, in order. */
export function pathParamsOf(expressPath: string): string[] {
  return [...expressPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

/** A concrete request path for an Express pattern, with every parameter filled in. */
export function samplePathFor(expressPath: string): string {
  return expressPath.replace(
    /:([A-Za-z0-9_]+)/g,
    (_match, name: string) => `__${name.toLowerCase()}__`,
  );
}

/* ------------------------------------------------------------------------ */
/* Dispatch replay                                                           */
/* ------------------------------------------------------------------------ */

type Candidate = {
  route: ExpressRoute;
  method: HttpMethod;
  expressPath: string;
};

function routeHandlesMethod(route: ExpressRoute, method: HttpMethod): boolean {
  return Boolean(route.methods._all || route.methods[method]);
}

/** The prefix of `path` a layer matches, or null — `Layer.prototype.match` without its side effects. */
function matchedPrefix(layer: ExpressLayer, path: string): string | null {
  if (layer.regexp.fast_slash) return "";
  if (layer.regexp.fast_star) return path;
  const match = layer.regexp.exec(path);
  return match ? match[0] : null;
}

/** What `req.path` becomes below a mount that matched `prefix` — Express's `trim_prefix`. */
function below(path: string, prefix: string): string {
  if (!prefix) return path;
  const rest = path.slice(prefix.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

type Replay = {
  chain: ChainLink[];
  routers: unknown[];
  shadowedBy?: string;
  routePath?: string;
  handlers?: unknown[];
};

/**
 * Walk `stack` the way `Router.prototype.handle` would for `method path`,
 * recording every middleware that runs, until `target` answers. Returns false
 * when the target is never reached.
 */
function replay(
  stack: ExpressLayer[],
  path: string,
  target: Candidate,
  state: Replay,
  prefix: string,
): boolean {
  for (const layer of stack) {
    // Error handlers only run once something has failed.
    if (layer.handle.length === 4) continue;
    const matched = matchedPrefix(layer, path);
    if (matched === null) continue;
    if (layer.route) {
      if (!routeHandlesMethod(layer.route, target.method)) continue;
      if (layer.route === target.route) {
        state.routePath = path;
        state.handlers = layer.route.stack
          .filter((inner) => !inner.method || inner.method === target.method)
          .map((inner) => inner.handle);
        return true;
      }
      // Express runs this one first; the target only runs if it calls next().
      state.shadowedBy ??= `${target.method.toUpperCase()} ${joinRoutePath(prefix, String(layer.route.path))}`;
      continue;
    }
    if (isRouter(layer.handle)) {
      state.routers.push(layer.handle);
      const mounted = prefix + cachedMountPathOf(layer);
      if (replay(layer.handle.stack, below(path, matched), target, state, mounted)) {
        return true;
      }
      state.routers.pop();
      continue;
    }
    state.chain.push({ handle: layer.handle, path: below(path, matched) });
  }
  return false;
}

/* ------------------------------------------------------------------------ */
/* Discovery                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * List every route `app` answers, with the middleware chain in front of each.
 * Routes appear in registration order; routes the walker cannot describe (a
 * RegExp path, `router.all`) are reported in `undocumentable` rather than
 * dropped.
 */
export function discoverRoutes(app: unknown): RouteDiscovery {
  const root = rootStackOf(app);
  const candidates: Candidate[] = [];
  const undocumentable: UndocumentableRoute[] = [];

  const collect = (stack: ExpressLayer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const routePath = layer.route.path;
        const methods = Object.keys(layer.route.methods).filter((key) => layer.route?.methods[key]);
        if (typeof routePath !== "string") {
          for (const method of methods) {
            undocumentable.push({
              method: method.toUpperCase(),
              expressPath: `${prefix}${String(routePath)}`,
              reason: "The route path is not a string",
            });
          }
          continue;
        }
        const expressPath = joinRoutePath(prefix, routePath);
        for (const method of methods) {
          if (!(HTTP_METHODS as readonly string[]).includes(method)) {
            undocumentable.push({
              method: method === "_all" ? "ALL" : method.toUpperCase(),
              expressPath,
              reason: `${method === "_all" ? "router.all()" : method.toUpperCase()} is not a documentable HTTP method`,
            });
            continue;
          }
          if (/[?*(]/.test(routePath) || /[?*(]/.test(prefix)) {
            undocumentable.push({
              method: method.toUpperCase(),
              expressPath,
              reason: "The route path uses an optional, wildcard or pattern segment",
            });
            continue;
          }
          candidates.push({ route: layer.route, method: method as HttpMethod, expressPath });
        }
        continue;
      }
      if (isRouter(layer.handle)) {
        collect(layer.handle.stack, prefix + cachedMountPathOf(layer));
      }
    }
  };
  collect(root, "");

  const routes: DiscoveredRoute[] = [];
  for (const candidate of candidates) {
    const state: Replay = { chain: [], routers: [] };
    if (!replay(root, samplePathFor(candidate.expressPath), candidate, state, "")) {
      undocumentable.push({
        method: candidate.method.toUpperCase(),
        expressPath: candidate.expressPath,
        reason: "No request reaches this route",
      });
      continue;
    }
    routes.push({
      method: candidate.method,
      expressPath: candidate.expressPath,
      path: toOpenApiPath(candidate.expressPath),
      pathParams: pathParamsOf(candidate.expressPath),
      chain: state.chain,
      handlers: state.handlers ?? [],
      routePath: state.routePath ?? "/",
      routers: state.routers,
      ...(state.shadowedBy ? { shadowedBy: state.shadowedBy } : {}),
    });
  }
  return { routes, undocumentable };
}
