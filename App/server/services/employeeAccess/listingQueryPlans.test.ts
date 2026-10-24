import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { Logger } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { createVaultItem } from "../vault.js";
import { initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { listEmployeeAccess } from "./listing.js";

/**
 * The Access listing's reads stay bounded on a large company (AGENTS.md §7).
 *
 * SQLite answers on the event loop, so one listing that walked every note body
 * in a big company would freeze every other request while it ran. Here a
 * company holds 3,000 notes whose bodies spill past a page (and 300 in the
 * trash), 2,000 Resources with long text, and hundreds of everything else,
 * beside two more companies of the same size, with real planner statistics.
 * Every statement the listing sends must reach its rows through an index, the
 * big tables' pages must be walked in index order so `LIMIT` ends the walk,
 * and the trash check must read `archivedAt` by primary key only.
 */

type Plan = { sql: string; steps: string[] };

async function traced<T>(work: () => Promise<T>): Promise<{ plans: Plan[]; result: T; sent: number }> {
  const sent: { sql: string; params: unknown[] }[] = [];
  const capture: Logger = {
    logQuery: (sql, params) => void sent.push({ sql, params: params ?? [] }),
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };
  const original = AppDataSource.logger;
  Object.assign(AppDataSource, { logger: capture });
  let result: T;
  try {
    result = await work();
  } finally {
    Object.assign(AppDataSource, { logger: original });
  }
  const plans: Plan[] = [];
  for (const { sql, params } of sent) {
    if (!/^\s*SELECT/i.test(sql)) continue;
    const rows = (await AppDataSource.query(`EXPLAIN QUERY PLAN ${sql}`, params)) as { detail: string }[];
    plans.push({ sql, steps: rows.map((row) => row.detail) });
  }
  return { plans, result, sent: sent.length };
}

/** The tables a statement reads, from its FROM and JOIN clauses. */
function tablesOf(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+"([a-z_]+)"/g)].map((match) => match[1]);
}

const COMPANY = "c1";
const EMPLOYEE = "e1";
const OWNER = "u1";

/** The tables a listing reads: none may be scanned. */
const TABLES = [
  "notes",
  "notebooks",
  "resources",
  "charts",
  "dashboards",
  "bases",
  "code_repositories",
  "integration_connections",
  "mail_accounts",
  "calendar_accounts",
  "vault_items",
  "vault_item_member_access",
  "member_browsers",
  "users",
];

describe("the Access listing on a large company", () => {
  before(async () => {
    await initTestDb();
    await resetTestDb();
    await AppDataSource.query(`
      INSERT INTO users (id, email, name, passwordHash, sessionVersion) VALUES
        ('u1', 'owner@example.test', 'Owner', 'x', 0), ('u2', 'two@example.test', 'Two', 'x', 0)`);
    await AppDataSource.query(`
      INSERT INTO companies (id, name, slug, ownerId) VALUES
        ('c1', 'Big', 'big', 'u1'), ('c2', 'Other', 'other', 'u2'), ('c3', 'Third', 'third', 'u2')`);
    await AppDataSource.query(`
      INSERT INTO ai_employees (id, companyId, name, slug, role) VALUES
        ('e1', 'c1', 'Ada', 'ada', 'Ops'), ('e2', 'c2', 'Bea', 'bea', 'Ops')`);
    const body = "x".repeat(6_000);
    for (const company of ["c1", "c2", "c3"]) {
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
        INSERT INTO notebooks (id, companyId, title, slug)
        SELECT '${company}-nb' || i, '${company}', 'Notebook ' || i, 'notebook-' || i FROM n`);
      await AppDataSource.query(
        `
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3300)
        INSERT INTO notes (id, companyId, notebookId, title, slug, body, parentId, archivedAt)
        SELECT '${company}-n' || i, '${company}', '${company}-nb' || ((i % 20) + 1), 'Page ' || i,
          printf('page-%05d', i), ?,
          CASE WHEN i % 7 = 0 THEN '${company}-n' || (i - 1) END,
          CASE WHEN i % 11 = 0 THEN '2026-01-01 00:00:00' END
        FROM n`,
        [body],
      );
      await AppDataSource.query(
        `
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO resources (id, companyId, title, slug, sourceKind, summary, bodyText, status)
        SELECT '${company}-r' || i, '${company}', 'Resource ' || i, printf('resource-%05d', i), 'text',
          'A summary.', ?, 'ready'
        FROM n`,
        [body],
      );
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
        INSERT INTO integration_connections (id, companyId, provider, label, authMode, encryptedConfig)
        SELECT '${company}-conn' || i, '${company}', 'stripe', 'Stripe ' || i, 'apikey', 'x' FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
        INSERT INTO charts (id, companyId, title, slug, connectionId, sql)
        SELECT '${company}-ch' || i, '${company}', 'Chart ' || i, 'chart-' || i, '${company}-conn1',
          'SELECT 1' FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
        INSERT INTO dashboards (id, companyId, title, slug)
        SELECT '${company}-d' || i, '${company}', 'Dashboard ' || i, 'dashboard-' || i FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
        INSERT INTO bases (id, companyId, name, slug)
        SELECT '${company}-b' || i, '${company}', 'Base ' || i, 'base-' || i FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
        INSERT INTO code_repositories (id, companyId, name, slug, gitUrl)
        SELECT '${company}-repo' || i, '${company}', 'Repo ' || i, 'repo-' || i, 'https://example.test/r.git'
        FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO mail_accounts (id, companyId, connectionId, address)
        SELECT '${company}-mail' || i, '${company}', '${company}-mailconn' || i, 'box' || i || '@acme.test'
        FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO calendar_accounts (id, companyId, connectionId, calendarId)
        SELECT '${company}-cal' || i, '${company}', '${company}-calconn' || i, 'primary' FROM n`);
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO member_browsers (id, companyId, ownerUserId, name, status)
        SELECT '${company}-mb' || i, '${company}', 'u1', 'Browser ' || i, 'offline' FROM n`);
    }
    // Other companies' Vault items: never decrypted here, only there to be skipped.
    for (const company of ["c2", "c3"]) {
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
        INSERT INTO vault_items (id, companyId, type, visibility, encryptedPayload, createdByUserId)
        SELECT '${company}-v' || i, '${company}', 'login', 'company', 'sealed', 'u2' FROM n`);
    }
    for (let i = 0; i < 25; i += 1) {
      await createVaultItem({
        companyId: COMPANY,
        actor: { userId: OWNER, role: "owner" },
        type: "login",
        visibility: "company",
        payload: {
          title: `Login ${i}`,
          username: "ops",
          secret: "s",
          websiteUrl: "",
          notes: "",
          totp: null,
          passkeys: [],
          passkeyRegistrationLease: null,
        },
      });
    }
    // Every Grant table holds thousands of other employees' rows, so the
    // planner's statistics see the tables a real company has.
    const grantTables: Array<[table: string, resource: string | null, level: string | null, company: boolean]> = [
      ["employee_connection_grants", "connectionId", null, false],
      ["employee_mail_account_grants", "accountId", "draft", false],
      ["employee_calendar_grants", "accountId", "read", false],
      ["employee_code_repository_grants", "repositoryId", "write", false],
      ["employee_notebook_grants", "notebookId", "write", false],
      ["employee_note_grants", "noteId", "write", false],
      ["employee_base_grants", "baseId", null, false],
      ["employee_chart_grants", "chartId", "read", false],
      ["employee_dashboard_grants", "dashboardId", "read", false],
      ["employee_resource_grants", "resourceId", "read", false],
      ["employee_vault_grants", "vaultItemId", "use", true],
      ["employee_member_browser_grants", "memberBrowserId", null, true],
      ["employee_resource_library_grants", null, "write", true],
      ["employee_routine_grants", null, "write", true],
      ["employee_finance_grants", null, "read", true],
      ["employee_revenue_grants", null, "read", true],
      ["employee_marketing_grants", null, "read", true],
      ["employee_recruiting_grants", null, "read", true],
      ["employee_signing_grants", null, "read", true],
    ];
    for (const [table, resource, level, company] of grantTables) {
      const columns = ["id", "employeeId", resource, level ? "accessLevel" : null, company ? "companyId" : null]
        .filter(Boolean)
        .map((column) => `"${column}"`)
        .join(", ");
      const values = [
        `'${table}-' || i`,
        "'other-e' || i",
        resource ? `'c2-res' || (i % 50)` : null,
        level ? `'${level}'` : null,
        company ? "'c2'" : null,
      ]
        .filter(Boolean)
        .join(", ");
      await AppDataSource.query(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
        INSERT INTO ${table} (${columns}) SELECT ${values} FROM n`);
    }
    // Some Grants the employee holds, including on rows far past any page.
    await AppDataSource.query(`
      INSERT INTO employee_note_grants (id, employeeId, noteId, accessLevel) VALUES
        ('g1', 'e1', 'c1-n3001', 'write'), ('g2', 'e1', 'c1-n10', 'read')`);
    await AppDataSource.query(`
      INSERT INTO employee_notebook_grants (id, employeeId, notebookId, accessLevel) VALUES
        ('g3', 'e1', 'c1-nb3', 'read')`);
    await AppDataSource.query(`
      INSERT INTO employee_resource_grants (id, employeeId, resourceId, accessLevel) VALUES
        ('g4', 'e1', 'c1-r1999', 'edit')`);
    await AppDataSource.query(`
      INSERT INTO employee_finance_grants (id, companyId, employeeId, accessLevel) VALUES
        ('g5', 'c1', 'e1', 'read')`);
    await AppDataSource.query("ANALYZE");
  });

  test("every statement reaches its rows through an index, and the big pages end at their limit", async () => {
    const { plans, result, sent } = await traced(() =>
      listEmployeeAccess({
        companyId: COMPANY,
        employee: { id: EMPLOYEE, name: "Ada", slug: "ada" },
        viewer: { userId: OWNER, role: "owner", viaBearer: false, financeAccess: "full" },
      }),
    );
    assert.ok(plans.length > 20, `explained ${plans.length} statements`);
    assert.ok(sent < 120, `${sent} statements for one listing`);
    const read = new Set(plans.flatMap((plan) => tablesOf(plan.sql)));
    for (const table of TABLES) {
      if (table === "vault_item_member_access") continue;
      assert.ok(read.has(table), `the listing reads ${table}`);
    }
    for (const plan of plans) {
      for (const step of plan.steps) {
        // Plans name a table by its alias; a full scan of anything is a failure.
        assert.doesNotMatch(step, /^SCAN (?!CONSTANT ROW)/, `scans a table:\n${plan.sql}\n${plan.steps.join("\n")}`);
      }
    }
    // The notes and Resources pages are walked in index order: no sort of every row.
    const pages = plans.filter(
      (plan) => /FROM "(notes|resources)"/.test(plan.sql) && /LIMIT/.test(plan.sql) && /ORDER BY/.test(plan.sql),
    );
    assert.ok(pages.length >= 2, "the notes and Resources pages were explained");
    for (const plan of pages) {
      assert.ok(
        plan.steps.every((step) => !step.includes("TEMP B-TREE")),
        `sorts every row instead of walking the index:\n${plan.sql}\n${plan.steps.join("\n")}`,
      );
      assert.ok(
        plan.steps.some((step) => /^SEARCH \S+ USING (COVERING )?INDEX \S+ \(companyId=\?/.test(step)),
        `walks the company through an index:\n${plan.steps.join("\n")}`,
      );
    }
    // The trash check reads `archivedAt` for the page's own rows, by primary key.
    const trash = plans.filter((plan) => /FROM "notes"/.test(plan.sql) && /archivedAt" IS NOT NULL/.test(plan.sql));
    assert.ok(trash.length > 0);
    for (const plan of trash) {
      assert.ok(
        plan.steps.some((step) => /USING (COVERING )?INDEX sqlite_autoindex_notes_1 \(id=\?\)/.test(step)),
        `checks the trash by id:\n${plan.steps.join("\n")}`,
      );
    }

    // And it is still the right answer.
    const notes = result.items.filter((item) => item.kind === "note");
    assert.equal(result.kinds.find((entry) => entry.kind === "note")?.truncated, true);
    assert.ok(notes.length >= result.limit, "a full page of live notes");
    assert.ok(notes.some((item) => item.resourceId === "c1-n3001" && item.grant?.level === "write"));
    assert.ok(notes.every((item) => Number(item.resourceId!.split("-n")[1]) % 11 !== 0), "nothing from the trash");
    assert.ok(notes.every((item) => item.resourceId!.startsWith("c1-")), "nothing from another company");
    assert.ok(result.items.some((item) => item.resourceId === "c1-r1999" && item.grant?.level === "edit"));
    assert.equal(result.items.filter((item) => item.kind === "vault_item").length, 25);
  });

  test("a search stays on the indexes too", async () => {
    const { plans, result } = await traced(() =>
      listEmployeeAccess({
        companyId: COMPANY,
        employee: { id: EMPLOYEE, name: "Ada", slug: "ada" },
        viewer: { userId: OWNER, role: "owner", viaBearer: false, financeAccess: "full" },
        query: "page 3299",
      }),
    );
    for (const plan of plans) {
      for (const step of plan.steps) {
        assert.doesNotMatch(step, /^SCAN (notes|resources|charts|dashboards|bases)\b/, plan.sql);
      }
    }
    assert.deepEqual(
      result.items.filter((item) => item.kind === "note").map((item) => item.resourceId),
      ["c1-n3299"],
    );
  });
});
