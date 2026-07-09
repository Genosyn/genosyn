import { MigrationInterface, QueryRunner } from "typeorm";
import { randomUUID } from "node:crypto";

/**
 * M20 follow-up — per-employee Read/Write grants on Charts and Dashboards.
 *
 * Tables + indexes are TypeORM-generated; the back-fill below is the
 * non-mechanical bit. Without it every existing Chart and Dashboard
 * would silently flip to "no AI employee can see this" on deploy, since
 * the new MCP gates filter by `EmployeeChartGrant` / `EmployeeDashboardGrant`.
 *
 * Back-fill rule: every existing AI employee gets `read` on every
 * existing Chart and Dashboard in the same company. Matches the
 * company-scoped default before grants existed.
 */
export class M20ExploreGrants1781500000000 implements MigrationInterface {
  name = "M20ExploreGrants1781500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_chart_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "chartId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_6d8e2f5669778d6f41f55be118" ON "employee_chart_grants" ("employeeId", "chartId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_db4e91603d28d3588e61e0e03a" ON "employee_chart_grants" ("chartId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cf6f38fe61de6cec090c876562" ON "employee_chart_grants" ("employeeId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "employee_dashboard_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "dashboardId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_daa18a8e61b39e483c54fae4ae" ON "employee_dashboard_grants" ("employeeId", "dashboardId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_568d6dc882fa8354935d0c9631" ON "employee_dashboard_grants" ("dashboardId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4669ae8a3773bbf599f8d0d052" ON "employee_dashboard_grants" ("employeeId") `,
    );

    // Back-fill: read grants on every existing (employee, chart) and
    // (employee, dashboard) pair within the same company. Each pair is
    // a single bound query — fine for current scale (charts in the
    // single-digit thousands at most per company).
    const chartPairs: Array<{ empId: string; rowId: string }> =
      await queryRunner.query(
        `SELECT e.id AS empId, c.id AS rowId
           FROM "ai_employees" e
          INNER JOIN "charts" c ON c."companyId" = e."companyId"`,
      );
    for (const p of chartPairs) {
      await queryRunner.query(
        `INSERT INTO "employee_chart_grants" ("id", "employeeId", "chartId", "accessLevel", "createdAt")
         VALUES (?, ?, ?, 'read', datetime('now'))`,
        [randomUUID(), p.empId, p.rowId],
      );
    }

    const dashboardPairs: Array<{ empId: string; rowId: string }> =
      await queryRunner.query(
        `SELECT e.id AS empId, d.id AS rowId
           FROM "ai_employees" e
          INNER JOIN "dashboards" d ON d."companyId" = e."companyId"`,
      );
    for (const p of dashboardPairs) {
      await queryRunner.query(
        `INSERT INTO "employee_dashboard_grants" ("id", "employeeId", "dashboardId", "accessLevel", "createdAt")
         VALUES (?, ?, ?, 'read', datetime('now'))`,
        [randomUUID(), p.empId, p.rowId],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_4669ae8a3773bbf599f8d0d052"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_568d6dc882fa8354935d0c9631"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_daa18a8e61b39e483c54fae4ae"`);
    await queryRunner.query(`DROP TABLE "employee_dashboard_grants"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cf6f38fe61de6cec090c876562"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_db4e91603d28d3588e61e0e03a"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_6d8e2f5669778d6f41f55be118"`);
    await queryRunner.query(`DROP TABLE "employee_chart_grants"`);
  }
}
