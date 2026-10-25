import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AppDataSource } from "../../db/datasource.js";
import { CALENDAR_ACCESS_LEVELS } from "../../db/entities/EmployeeCalendarGrant.js";
import { CHART_ACCESS_LEVELS } from "../../db/entities/EmployeeChartGrant.js";
import { FINANCE_ACCESS_LEVELS } from "../../db/entities/EmployeeFinanceGrant.js";
import { MAIL_ACCESS_LEVELS } from "../../db/entities/EmployeeMailAccountGrant.js";
import { MARKETING_ACCESS_LEVELS } from "../../db/entities/EmployeeMarketingGrant.js";
import { RECRUITING_ACCESS_LEVELS } from "../../db/entities/EmployeeRecruitingGrant.js";
import { REPOSITORY_ACCESS_LEVELS } from "../../db/entities/EmployeeRepositoryGrant.js";
import { RESOURCE_ACCESS_LEVELS } from "../../db/entities/EmployeeResourceGrant.js";
import {
  DEFAULT_RESOURCE_LIBRARY_ACCESS,
  RESOURCE_LIBRARY_ACCESS_LEVELS,
} from "../../db/entities/EmployeeResourceLibraryGrant.js";
import { REVENUE_ACCESS_LEVELS } from "../../db/entities/EmployeeRevenueGrant.js";
import { DEFAULT_ROUTINE_ACCESS, ROUTINE_ACCESS_LEVELS } from "../../db/entities/EmployeeRoutineGrant.js";
import { SIGNING_ACCESS_LEVELS } from "../../db/entities/EmployeeSigningGrant.js";
import { DATA_ROOM_ACCESS_LEVELS } from "../../db/entities/EmployeeDataRoomGrant.js";
import { EMPLOYEE_VAULT_ACCESS_LEVELS } from "../../db/entities/EmployeeVaultGrant.js";
import { closeTestDb, initTestDb } from "../../test/dbHarness.js";
import {
  ACCESS_GROUPS,
  ACCESS_KINDS,
  ACCESS_KIND_META,
  accessItemKey,
  accessLevelLabel,
  accessLevelValues,
  isAccessKind,
  isAccessLevel,
  isRevocableKind,
  type AccessKind,
} from "../../../shared/employeeAccess.js";
import { ACCESS_ROUTES, GRANT_SOURCES } from "./bulk.js";

/**
 * The Access page's catalogue (`shared/employeeAccess.ts`) against the Grants
 * it gathers. The client cannot import an entity, so the catalogue spells out
 * each kind's levels again; these tests fail the day an entity grows a level,
 * changes a default, or a new `Employee*Grant` table appears that the page
 * does not know about.
 */

before(initTestDb);
after(closeTestDb);

const ENTITY_LEVELS: Record<AccessKind, readonly string[]> = {
  connection: [],
  mail_account: MAIL_ACCESS_LEVELS,
  calendar: CALENDAR_ACCESS_LEVELS,
  repository: REPOSITORY_ACCESS_LEVELS,
  notebook: ["read", "write"],
  note: ["read", "write"],
  base: [],
  chart: CHART_ACCESS_LEVELS,
  dashboard: CHART_ACCESS_LEVELS,
  resource_library: RESOURCE_LIBRARY_ACCESS_LEVELS,
  resource: RESOURCE_ACCESS_LEVELS,
  vault_item: EMPLOYEE_VAULT_ACCESS_LEVELS,
  member_browser: [],
  routines: ROUTINE_ACCESS_LEVELS,
  finance: FINANCE_ACCESS_LEVELS,
  revenue: REVENUE_ACCESS_LEVELS,
  marketing: MARKETING_ACCESS_LEVELS,
  recruiting: RECRUITING_ACCESS_LEVELS,
  signing: SIGNING_ACCESS_LEVELS,
  data_room: DATA_ROOM_ACCESS_LEVELS,
};

describe("the Access catalogue", () => {
  test("every kind's levels are its entity's, narrowest first", () => {
    for (const kind of ACCESS_KINDS) {
      assert.deepEqual(accessLevelValues(kind), [...ENTITY_LEVELS[kind]], kind);
    }
  });

  test("every Employee*Grant table is a kind on the page", () => {
    const grantTables = AppDataSource.entityMetadatas
      .map((metadata) => metadata.name)
      .filter((name) => /^Employee.*Grant$/.test(name))
      .sort();
    const covered = ACCESS_KINDS.map((kind) => {
      const entity = GRANT_SOURCES[kind].entity as { name: string };
      return entity.name;
    }).sort();
    assert.deepEqual(covered, grantTables);
    assert.equal(grantTables.length, 20, "the task named 19 grant tables; data rooms added the 20th");
  });

  test("a new Grant takes the level its own table or route gives it", () => {
    // The stored column default where the route sends no level of its own.
    const columnDefault = (kind: AccessKind) => {
      const metadata = AppDataSource.getMetadata(GRANT_SOURCES[kind].entity);
      return metadata.findColumnWithPropertyName("accessLevel")?.default ?? null;
    };
    for (const kind of ["mail_account", "vault_item", "note", "notebook", "repository"] as const) {
      assert.equal(ACCESS_KIND_META[kind].defaultLevel, columnDefault(kind), kind);
    }
    // The routes' own defaults when a panel sends none.
    assert.equal(ACCESS_KIND_META.chart.defaultLevel, "read");
    assert.equal(ACCESS_KIND_META.dashboard.defaultLevel, "read");
    assert.equal(ACCESS_KIND_META.resource.defaultLevel, "read");
    assert.equal(ACCESS_KIND_META.finance.defaultLevel, "read");
    for (const kind of ACCESS_KINDS) {
      const meta = ACCESS_KIND_META[kind];
      if (meta.levels.length === 0) assert.equal(meta.defaultLevel, null, kind);
      else assert.ok(isAccessLevel(kind, meta.defaultLevel), kind);
    }
  });

  test("Routines and the Resources library are held by every employee at their defaults", () => {
    assert.equal(ACCESS_KIND_META.routines.heldByDefault, DEFAULT_ROUTINE_ACCESS);
    assert.equal(ACCESS_KIND_META.resource_library.heldByDefault, DEFAULT_RESOURCE_LIBRARY_ACCESS);
    for (const kind of ACCESS_KINDS) {
      const held = ACCESS_KIND_META[kind].heldByDefault !== null;
      assert.equal(isRevocableKind(kind), !held, kind);
      assert.equal(held, kind === "routines" || kind === "resource_library", kind);
    }
  });

  test("each kind sits in exactly one group, in a group that lists it", () => {
    const seen = new Map<AccessKind, string>();
    for (const group of ACCESS_GROUPS) {
      for (const kind of group.kinds) {
        assert.equal(seen.has(kind), false, `${kind} is in two groups`);
        seen.set(kind, group.key);
        assert.equal(ACCESS_KIND_META[kind].group, group.key, kind);
      }
    }
    assert.deepEqual([...seen.keys()].sort(), [...ACCESS_KINDS].sort());
  });

  test("the page groups the kinds the task named", () => {
    assert.deepEqual(
      ACCESS_GROUPS.map((group) => group.label),
      [
        "Connections",
        "Mailboxes",
        "Calendars",
        "Repositories",
        "Notes and notebooks",
        "Bases",
        "Charts and dashboards",
        "Resources",
        "Vault items",
        "Member browsers",
        "Routines",
        "Company sections",
      ],
    );
    assert.deepEqual(
      ACCESS_GROUPS.find((group) => group.key === "sections")?.kinds,
      ["finance", "revenue", "marketing", "recruiting", "signing", "data_room"],
    );
  });

  test("each kind has a route for every change it can take", () => {
    for (const kind of ACCESS_KINDS) {
      const meta = ACCESS_KIND_META[kind];
      const routes = ACCESS_ROUTES[kind];
      assert.ok(routes.grant, `${kind} grant`);
      assert.equal(Boolean(routes.setLevel), meta.levels.length > 0, `${kind} set level`);
      assert.equal(Boolean(routes.revoke), meta.heldByDefault === null, `${kind} revoke`);
    }
  });

  test("every replayed request names a route the App serves", () => {
    // The path shapes, as a panel would send them, against the routers' own
    // source — so a route that moves fails here before a Member finds out.
    const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../routes");
    const source = fs
      .readdirSync(routesDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => fs.readFileSync(path.join(routesDir, file), "utf8"))
      .join("\n");
    const id = "11111111-1111-4111-8111-111111111111";
    const resource = { id, slug: "the-slug", ownerUserId: null, ownerName: null };
    for (const kind of ACCESS_KINDS) {
      const routes = ACCESS_ROUTES[kind];
      for (const build of [routes.grant, routes.setLevel, routes.revoke]) {
        if (!build) continue;
        const operation = build({ employeeId: id, resource, grantId: id, level: "read" });
        // `/notes/the-slug/grants/<id>` → `/notes/:x/grants/:x`, then the
        // router-relative suffix every router registers.
        const template = operation.path
          .replace(/the-slug/g, ":x")
          .replace(new RegExp(id, "g"), ":x");
        const segments = template.split("/").filter(Boolean);
        const literal = segments.filter((segment) => segment !== ":x");
        assert.ok(
          literal.every((segment) => source.includes(segment)),
          `${kind} ${operation.method} ${operation.path} names a route the routers serve`,
        );
      }
    }
  });

  test("helpers read the catalogue", () => {
    assert.equal(isAccessKind("vault_item"), true);
    assert.equal(isAccessKind("vault"), false);
    assert.equal(isAccessLevel("mail_account", "send"), true);
    assert.equal(isAccessLevel("note", "send"), false);
    assert.equal(accessLevelLabel("finance", "invoice"), "Invoicing");
    assert.equal(accessLevelLabel("finance", "mystery"), "mystery");
    assert.equal(accessLevelLabel("finance", null), "");
    assert.equal(accessItemKey("note", "n1"), "note:n1");
    assert.equal(accessItemKey("finance", null), "finance");
  });
});
