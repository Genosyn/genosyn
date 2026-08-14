import assert from "node:assert/strict";
import test from "node:test";
import { companyIdFromApiPath, matchesRoutePath, roleAtLeast } from "./auth.js";

test("company role hierarchy is monotonic", () => {
  assert.equal(roleAtLeast("member", "member"), true);
  assert.equal(roleAtLeast("member", "admin"), true);
  assert.equal(roleAtLeast("admin", "owner"), true);
  assert.equal(roleAtLeast("admin", "member"), false);
  assert.equal(roleAtLeast("owner", "admin"), false);
});

test("company API-key paths are recognized narrowly and safely", () => {
  assert.equal(companyIdFromApiPath("/api/companies/company-id"), "company-id");
  assert.equal(companyIdFromApiPath("/api/companies/company-id/routines?limit=10"), "company-id");
  assert.equal(companyIdFromApiPath("/api/companies/company%20id/audit"), "company id");
  assert.equal(companyIdFromApiPath("/api/companies"), null);
  assert.equal(companyIdFromApiPath("/api/companies/"), null);
  assert.equal(companyIdFromApiPath("/api/auth/me"), null);
  assert.equal(companyIdFromApiPath("/api/admin"), null);
  assert.equal(companyIdFromApiPath("/api/companies/%ZZ/audit"), null);
});

test("router guards match only their owned company paths", () => {
  const matchers = ["/audit", /^\/employees\/[^/]+\/skills(?:\/|$)/];
  assert.equal(matchesRoutePath("/audit", matchers), true);
  assert.equal(matchesRoutePath("/audit/export", matchers), true);
  assert.equal(matchesRoutePath("/employees/employee-id/skills", matchers), true);
  assert.equal(matchesRoutePath("/workspace/ws-token", matchers), false);
  assert.equal(matchesRoutePath("/finance/invoices", matchers), false);
});
