import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RequestHandler } from "express";

import { indefiniteArticle } from "../../shared/indefiniteArticle.js";
import {
  onRoutePaths,
  requireApiKeyAuth,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
  requireCompanyRoleForMutations,
  requireMasterAdmin,
} from "../middleware/auth.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import {
  describeBrowserSessionCondition,
  describeBrowserSessionOnly,
} from "../middleware/routeMetadata.js";
import { accessDescription, accessExtension, accessOf, securityFor } from "./routeAccess.js";
import type { HttpMethod } from "./routeDiscovery.js";

/**
 * The access classification read off a route's guards, on synthetic chains.
 * `apiKeySweep.test.ts` checks the same classification against the real
 * server for every route; these tests pin each rule on its own.
 */

const COMPANY = "/api/companies/{cid}/things";

function route(
  guards: unknown[],
  options: {
    method?: HttpMethod;
    path?: string;
    routeHandlers?: unknown[];
    seenPath?: string;
  } = {},
) {
  return {
    method: options.method ?? "get",
    path: options.path ?? COMPANY,
    chain: guards.map((handle) => ({ handle, path: options.seenPath ?? "/things" })),
    handlers: options.routeHandlers ?? [() => undefined],
    routePath: options.seenPath ?? "/things",
  };
}

const noop: RequestHandler = (_req, _res, next) => next();

describe("who may call a route", () => {
  test("no requireAuth means public", () => {
    const access = accessOf(route([noop]));
    assert.equal(access.authenticated, false);
    assert.equal(access.apiKey, false);
    assert.equal(access.sessionOnly, undefined);
    assert.deepEqual(securityFor(access), []);
  });

  test("requireAuth below a company path accepts a key or a session", () => {
    const access = accessOf(route([requireAuth, requireCompanyMember]));
    assert.equal(access.authenticated, true);
    assert.equal(access.apiKey, true);
    assert.equal(access.companyMember, true);
    assert.deepEqual(securityFor(access), [{ bearerAuth: [] }, { cookieAuth: [] }]);
  });

  test("requireAuth outside a company path is browser-only, whatever else runs", () => {
    for (const path of [
      "/api/auth/me",
      "/api/companies",
      "/api/push/subscriptions",
      "/api/chat-surfaces/bind",
    ]) {
      const access = accessOf(route([requireAuth], { path }));
      assert.equal(access.apiKey, false, path);
      assert.equal(access.sessionOnly, "accountLevel", path);
      assert.deepEqual(securityFor(access), [{ cookieAuth: [] }]);
    }
  });

  test("the company root itself is a company path", () => {
    assert.equal(accessOf(route([requireAuth], { path: "/api/companies/{cid}" })).apiKey, true);
  });

  test("requireBrowserSession anywhere in the chain or the route refuses keys", () => {
    assert.equal(
      accessOf(route([requireAuth, requireBrowserSession])).sessionOnly,
      "browserSession",
    );
    assert.equal(
      accessOf(route([requireAuth], { routeHandlers: [requireBrowserSession, noop] })).sessionOnly,
      "browserSession",
    );
  });

  test("a hand-written guard marked browser-only refuses keys too", () => {
    const guard = describeBrowserSessionOnly<RequestHandler>((_req, _res, next) => next());
    assert.equal(accessOf(route([requireAuth, guard])).sessionOnly, "browserSession");
  });

  test("requireMasterAdmin is instance administration, ahead of every other reason", () => {
    const access = accessOf(
      route([requireAuth, requireMasterAdmin, requireBrowserSession], { path: "/api/admin/users" }),
    );
    assert.equal(access.sessionOnly, "masterAdmin");
    assert.equal(access.apiKey, false);
  });

  test("guards before requireAuth on a public route still leave it public", () => {
    // requireBrowserSession without requireAuth cannot authenticate anyone;
    // the classification follows requireAuth.
    assert.equal(accessOf(route([requireBrowserSession])).authenticated, false);
  });
});

describe("routes that take an API key and nothing else", () => {
  test("requireApiKeyAuth authenticates, takes a key, and never a session", () => {
    const access = accessOf(route([requireApiKeyAuth, requireCompanyMember]));
    assert.equal(access.authenticated, true);
    assert.equal(access.apiKey, true);
    assert.equal(access.apiKeyOnly, true);
    assert.equal(access.sessionOnly, undefined);
    assert.equal(access.companyMember, true);
    assert.deepEqual(securityFor(access), [{ bearerAuth: [] }]);
    assert.deepEqual(accessExtension(access), { apiKey: true, browserSession: false });
  });

  test("its paragraph says a cookie alone is refused", () => {
    const text = accessDescription(accessOf(route([requireApiKeyAuth])), COMPANY);
    assert.match(text, /Needs an API key for this company/);
    assert.match(text, /a cookie alone is refused with 401/);
    for (const [, article, word] of text.matchAll(/\b(a|an)\s+([A-Za-z]+)/gi)) {
      assert.equal(article.toLowerCase(), indefiniteArticle(word), `"${article} ${word}"`);
    }
  });

  test("role and Finance gates still apply on top", () => {
    const access = accessOf(
      route([
        requireApiKeyAuth,
        requireCompanyMember,
        requireCompanyRole("admin"),
        requireFinanceRead,
      ]),
    );
    assert.equal(access.apiKeyOnly, true);
    assert.equal(access.minimumRole, "admin");
    assert.equal(access.financeAccess, "read");
    assert.deepEqual(accessExtension(access), {
      apiKey: true,
      browserSession: false,
      minimumRole: "admin",
      financeAccess: "read",
    });
  });

  test("outside a company path no key is recognized, so it is not key-only either", () => {
    const access = accessOf(route([requireApiKeyAuth], { path: "/api/auth/me" }));
    assert.equal(access.sessionOnly, "accountLevel");
    assert.equal(access.apiKey, false);
    assert.equal(access.apiKeyOnly, undefined);
  });

  test("a plain requireAuth route is never marked key-only", () => {
    assert.equal(accessOf(route([requireAuth])).apiKeyOnly, undefined);
  });
});

describe("guards scoped with onRoutePaths", () => {
  const scoped = onRoutePaths(["/api-keys"], requireBrowserSession);

  test("apply on the paths they name", () => {
    const access = accessOf(route([requireAuth, scoped], { seenPath: "/api-keys/123" }));
    assert.equal(access.sessionOnly, "browserSession");
  });

  test("and nowhere else — the leak repositories once had", () => {
    const access = accessOf(route([requireAuth, scoped], { seenPath: "/finance/invoices" }));
    assert.equal(access.apiKey, true);
  });

  test("match the way Express routes: any case, any trailing slash", () => {
    assert.equal(accessOf(route([requireAuth, scoped], { seenPath: "/API-KEYS/" })).apiKey, false);
  });

  test("scope role gates the same way", () => {
    const adminOnAudit = onRoutePaths(["/audit"], requireCompanyRole("admin"));
    assert.equal(
      accessOf(route([requireAuth, adminOnAudit], { seenPath: "/audit" })).minimumRole,
      "admin",
    );
    assert.equal(
      accessOf(route([requireAuth, adminOnAudit], { seenPath: "/goals" })).minimumRole,
      undefined,
    );
  });
});

describe("roles, Finance access and conditions", () => {
  test("the strictest role gate wins", () => {
    const access = accessOf(
      route([requireAuth, requireCompanyRole("admin"), requireCompanyRole("owner")]),
    );
    assert.equal(access.minimumRole, "owner");
    const reversed = accessOf(
      route([requireAuth, requireCompanyRole("owner"), requireCompanyRole("admin")]),
    );
    assert.equal(reversed.minimumRole, "owner");
  });

  test("a member gate is no restriction worth naming", () => {
    assert.equal(
      accessOf(route([requireAuth, requireCompanyRole("member")])).minimumRole,
      undefined,
    );
  });

  test("a mutations-only gate binds writes and leaves reads open", () => {
    const gate = requireCompanyRoleForMutations("admin");
    assert.equal(accessOf(route([requireAuth, gate], { method: "get" })).minimumRole, undefined);
    for (const method of ["post", "put", "patch", "delete"] as const) {
      assert.equal(accessOf(route([requireAuth, gate], { method })).minimumRole, "admin", method);
    }
  });

  test("Finance gates name the access a Member needs", () => {
    assert.equal(accessOf(route([requireAuth, requireFinanceRead])).financeAccess, "read");
    assert.equal(accessOf(route([requireAuth, requireFinanceWrite])).financeAccess, "full");
    assert.equal(
      accessOf(route([requireAuth, requireFinanceWrite, requireFinanceRead])).financeAccess,
      "full",
    );
  });

  test("a conditional browser gate keeps the key and says when it is refused", () => {
    const guard = describeBrowserSessionCondition<RequestHandler>(
      (_req, _res, next) => next(),
      "to assign an AI Employee",
    );
    const access = accessOf(
      route([requireAuth], { routeHandlers: [guard, guard, noop], method: "post" }),
    );
    assert.equal(access.apiKey, true);
    assert.deepEqual(access.browserSessionRequiredTo, ["to assign an AI Employee"]);
  });

  test("a browser-only route drops its conditions — there is nothing left to condition", () => {
    const guard = describeBrowserSessionCondition<RequestHandler>(
      (_req, _res, next) => next(),
      "to do it",
    );
    const access = accessOf(
      route([requireAuth, requireBrowserSession], { routeHandlers: [guard, noop] }),
    );
    assert.deepEqual(access.browserSessionRequiredTo, []);
  });
});

describe("how access reads in the reference", () => {
  const sentences = (text: string) => text.replace("**Access.** ", "");

  test("every kind of access gets its own paragraph", () => {
    assert.match(accessDescription(accessOf(route([noop])), COMPANY), /^\*\*Access\.\*\* Public/);
    assert.match(
      accessDescription(
        accessOf(route([noop], { path: "/api/sign/{token}" })),
        "/api/sign/{token}",
      ),
      /token in the path is the credential/,
    );
    assert.match(accessDescription(accessOf(route([requireAuth])), COMPANY), /Accepts an API key/);
    assert.match(
      accessDescription(accessOf(route([requireAuth], { path: "/api/auth/me" })), "/api/auth/me"),
      /Account-level/,
    );
    assert.match(
      accessDescription(accessOf(route([requireAuth, requireBrowserSession])), COMPANY),
      /API keys are refused with 403/,
    );
    assert.match(
      accessDescription(
        accessOf(route([requireAuth, requireMasterAdmin], { path: "/api/admin/x" })),
        "/api/admin/x",
      ),
      /master admin/,
    );
  });

  test("roles, Finance and conditions are spelled out", () => {
    const guard = describeBrowserSessionCondition<RequestHandler>(
      (_req, _res, next) => next(),
      "to mention an AI Employee",
    );
    const text = accessDescription(
      accessOf(
        route(
          [requireAuth, requireCompanyMember, requireCompanyRole("admin"), requireFinanceWrite],
          {
            routeHandlers: [guard, noop],
          },
        ),
      ),
      COMPANY,
    );
    assert.match(text, /must be a Member of the company/);
    assert.match(text, /Needs the admin company role or higher/);
    assert.match(text, /Needs full Finance access/);
    assert.match(text, /required to mention an AI Employee; API keys are refused for that/);
    // The reference's article rule holds for generated prose too.
    for (const [, article, word] of sentences(text).matchAll(/\b(a|an)\s+([A-Za-z]+)/gi)) {
      assert.equal(article.toLowerCase(), indefiniteArticle(word), `"${article} ${word}"`);
    }
  });

  test("the extension carries the same facts for machines", () => {
    assert.deepEqual(accessExtension(accessOf(route([requireAuth]))), {
      apiKey: true,
      browserSession: true,
    });
    assert.deepEqual(
      accessExtension(
        accessOf(route([requireAuth, requireCompanyRole("owner"), requireFinanceRead])),
      ),
      { apiKey: true, browserSession: true, minimumRole: "owner", financeAccess: "read" },
    );
    assert.deepEqual(accessExtension(accessOf(route([noop]))), {
      apiKey: false,
      browserSession: false,
    });
    assert.deepEqual(accessExtension(accessOf(route([requireAuth, requireBrowserSession]))), {
      apiKey: false,
      browserSession: true,
      sessionOnly: "browserSession",
    });
    assert.equal(
      accessExtension(accessOf(route([requireAuth], { path: "/api/auth/me" }))).sessionOnly,
      "accountLevel",
    );
  });
});
