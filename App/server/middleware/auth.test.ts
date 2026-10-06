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
  // Express routes case-insensitively, so the guard must too — otherwise
  // shouting a path skips the gate that protects it.
  assert.equal(matchesRoutePath("/AUDIT", matchers), true);
  assert.equal(matchesRoutePath("/Audit/Export", matchers), true);
  assert.equal(matchesRoutePath("/EMPLOYEES/employee-id/SKILLS", matchers), true);
});

test("router guards match a path whatever its trailing slash", () => {
  // Express routes non-strictly, so `PATCH /meetings/calendars/:id/` reaches
  // the handler registered without the slash. An anchored matcher that missed
  // that spelling let a plain Member arm auto-record on a calendar.
  const calendars = [/^\/meetings\/calendars$/, /^\/meetings\/calendars\/[^/]+$/];
  assert.equal(matchesRoutePath("/meetings/calendars/", calendars), true);
  assert.equal(matchesRoutePath("/meetings/calendars/calendar-id/", calendars), true);
  assert.equal(matchesRoutePath("/MEETINGS/Calendars/Calendar-Id/", calendars), true);
  // Trimming the slash must not pull in the child route the anchor leaves out.
  assert.equal(matchesRoutePath("/meetings/calendars/calendar-id/sync", calendars), false);
  assert.equal(matchesRoutePath("/meetings/calendars/calendar-id/sync/", calendars), false);

  // The employees router is mounted at `/employees`, so its collection is `/`.
  // The root stays "/" rather than trimming to nothing.
  const employees = [/^\/$/, /^\/[^/]+(?:\/soul|\/avatar)?$/];
  assert.equal(matchesRoutePath("/", employees), true);
  assert.equal(matchesRoutePath("/employee-id/", employees), true);
  assert.equal(matchesRoutePath("/employee-id/soul/", employees), true);
  assert.equal(matchesRoutePath("/employee-id/journal/", employees), false);

  // String matchers and slash-tolerant regexes already accepted the slash.
  assert.equal(matchesRoutePath("/audit/", ["/audit"]), true);
  assert.equal(matchesRoutePath("/audit/export/", ["/audit"]), true);
  assert.equal(
    matchesRoutePath("/employees/employee-id/skills/", [/^\/employees\/[^/]+\/skills(?:\/|$)/]),
    true,
  );
});
