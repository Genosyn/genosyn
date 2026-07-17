import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Chart } from "../db/entities/Chart.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  EmployeeChartGrant,
  CHART_ACCESS_LEVELS,
  type ChartAccessLevel,
} from "../db/entities/EmployeeChartGrant.js";
import { EmployeeDashboardGrant } from "../db/entities/EmployeeDashboardGrant.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import { params } from "../lib/params.js";
import {
  EXPLORE_PROVIDERS,
  deleteGrantsForChart,
  deleteGrantsForDashboard,
  grantChartToAllEmployees,
  grantDashboardToAllEmployees,
  isExploreProvider,
  listDirectChartGrants,
  listDirectDashboardGrants,
  runSqlAgainstConnection,
  serializeCard,
  serializeChart,
  serializeDashboard,
  uniqueChartSlug,
  uniqueDashboardSlug,
  upsertChartGrant,
  upsertDashboardGrant,
  VIZ_TYPES,
} from "../services/explore.js";
import { deleteTagAssignments } from "../services/tags.js";

/**
 * Explore — Metabase-style analytics over the company's existing database
 * integrations. Two primitives:
 *
 *   - **Chart**: saved SQL + visualization, bound to a postgres/mysql/
 *     clickhouse `IntegrationConnection`. Runs through the same shared
 *     driver pool as the integration tools.
 *   - **Dashboard**: grid of Chart cards. Cards carry their own
 *     position+size and optional title override.
 *
 * Execution uses `runSqlAgainstConnection` in `services/explore.ts` so
 * the executor logic stays in one place — shared between ad-hoc runs
 * (POST /run), saved-chart runs (POST /charts/:slug/run), and the MCP
 * tool surface.
 */
export const exploreRouter = Router({ mergeParams: true });
exploreRouter.use(requireAuth);
exploreRouter.use(requireCompanyMember);

const VIZ_ENUM = [
  "table",
  "scalar",
  "bar",
  "line",
  "area",
  "pie",
] as [string, ...string[]];

// ---------- Connections ----------

exploreRouter.get("/explore/connections", async (req, res) => {
  const { cid } = params(req);
  const rows = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId: cid, provider: In(EXPLORE_PROVIDERS as readonly string[]) },
    order: { createdAt: "ASC" },
  });
  res.json(
    rows.map((c) => ({
      id: c.id,
      provider: c.provider,
      label: c.label,
      accountHint: c.accountHint,
      status: c.status,
    })),
  );
});

// ---------- Ad-hoc run ----------

const runAdhocSchema = z.object({
  connectionId: z.string().uuid(),
  sql: z.string().min(1).max(50_000),
  maxRows: z.number().int().min(1).max(5000).optional(),
});

exploreRouter.post(
  "/explore/run",
  validateBody(runAdhocSchema),
  async (req, res) => {
    const { cid } = params(req);
    const body = req.body as z.infer<typeof runAdhocSchema>;
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: body.connectionId,
      companyId: cid,
    });
    if (!conn) return res.status(404).json({ error: "Connection not found" });
    if (!isExploreProvider(conn.provider)) {
      return res.status(400).json({
        error: `Connection provider "${conn.provider}" is not a supported Explore source`,
      });
    }
    try {
      const result = await runSqlAgainstConnection(conn, body.sql, {
        maxRows: body.maxRows,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// ---------- Charts: CRUD ----------

exploreRouter.get("/explore/charts", async (req, res) => {
  const { cid } = params(req);
  const rows = await AppDataSource.getRepository(Chart).find({
    where: { companyId: cid },
    order: { updatedAt: "DESC" },
  });
  res.json(rows.map((r) => serializeChart(r)));
});

const createChartSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  connectionId: z.string().uuid(),
  sql: z.string().min(1).max(50_000),
  vizType: z.enum(VIZ_ENUM).optional(),
  vizConfig: z.record(z.unknown()).optional(),
});

exploreRouter.post(
  "/explore/charts",
  validateBody(createChartSchema),
  async (req, res) => {
    const { cid } = params(req);
    const body = req.body as z.infer<typeof createChartSchema>;
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: body.connectionId,
      companyId: cid,
    });
    if (!conn) return res.status(400).json({ error: "Unknown connection" });
    if (!isExploreProvider(conn.provider)) {
      return res
        .status(400)
        .json({ error: "Connection is not a supported Explore source" });
    }
    const repo = AppDataSource.getRepository(Chart);
    const slug = await uniqueChartSlug(cid, body.title);
    const row = repo.create({
      companyId: cid,
      title: body.title,
      slug,
      description: body.description ?? "",
      connectionId: body.connectionId,
      sql: body.sql,
      vizType: (body.vizType ?? "table") as Chart["vizType"],
      vizConfig: JSON.stringify(body.vizConfig ?? {}),
      createdById: req.userId ?? null,
      createdByEmployeeId: null,
    });
    await repo.save(row);
    const granted = await grantChartToAllEmployees(cid, row.id);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "chart.create",
      targetType: "chart",
      targetId: row.id,
      targetLabel: row.title,
      metadata: {
        vizType: row.vizType,
        connectionId: row.connectionId,
        grantedToEmployees: granted,
      },
    });
    res.status(201).json(serializeChart(row));
  },
);

async function loadChart(
  companyId: string,
  slug: string,
): Promise<Chart | null> {
  return AppDataSource.getRepository(Chart).findOneBy({ companyId, slug });
}

exploreRouter.get("/explore/charts/:slug", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadChart(cid, slug);
  if (!row) return res.status(404).json({ error: "Chart not found" });
  res.json(serializeChart(row));
});

const patchChartSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  connectionId: z.string().uuid().optional(),
  sql: z.string().min(1).max(50_000).optional(),
  vizType: z.enum(VIZ_ENUM).optional(),
  vizConfig: z.record(z.unknown()).optional(),
});

exploreRouter.patch(
  "/explore/charts/:slug",
  validateBody(patchChartSchema),
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadChart(cid, slug);
    if (!row) return res.status(404).json({ error: "Chart not found" });
    const body = req.body as z.infer<typeof patchChartSchema>;
    if (body.title !== undefined) row.title = body.title;
    if (body.description !== undefined) row.description = body.description;
    if (body.connectionId !== undefined) {
      const conn = await AppDataSource.getRepository(
        IntegrationConnection,
      ).findOneBy({ id: body.connectionId, companyId: cid });
      if (!conn) return res.status(400).json({ error: "Unknown connection" });
      if (!isExploreProvider(conn.provider)) {
        return res
          .status(400)
          .json({ error: "Connection is not a supported Explore source" });
      }
      row.connectionId = body.connectionId;
    }
    if (body.sql !== undefined) row.sql = body.sql;
    if (body.vizType !== undefined) row.vizType = body.vizType as Chart["vizType"];
    if (body.vizConfig !== undefined) {
      row.vizConfig = JSON.stringify(body.vizConfig);
    }
    await AppDataSource.getRepository(Chart).save(row);
    res.json(serializeChart(row));
  },
);

exploreRouter.delete("/explore/charts/:slug", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadChart(cid, slug);
  if (!row) return res.status(404).json({ error: "Chart not found" });
  // Remove any DashboardCards pointing at this chart so dashboards don't
  // render placeholders. Done in the same request to keep the cleanup
  // visible — Charts and Cards don't have a FK constraint.
  await AppDataSource.getRepository(DashboardCard).delete({ chartId: row.id });
  await deleteGrantsForChart(row.id);
  await deleteTagAssignments("chart", row.id);
  await AppDataSource.getRepository(Chart).delete({ id: row.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "chart.delete",
    targetType: "chart",
    targetId: row.id,
    targetLabel: row.title,
  });
  res.json({ ok: true });
});

const runChartSchema = z
  .object({
    maxRows: z.number().int().min(1).max(5000).optional(),
  })
  .optional();

exploreRouter.post(
  "/explore/charts/:slug/run",
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadChart(cid, slug);
    if (!row) return res.status(404).json({ error: "Chart not found" });
    const parsed = runChartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "ValidationError" });
    }
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: row.connectionId,
      companyId: cid,
    });
    if (!conn) {
      return res
        .status(400)
        .json({ error: "Chart's connection no longer exists" });
    }
    try {
      const result = await runSqlAgainstConnection(conn, row.sql, {
        maxRows: parsed.data?.maxRows,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// ---------- Dashboards: CRUD ----------

exploreRouter.get("/explore/dashboards", async (req, res) => {
  const { cid } = params(req);
  const rows = await AppDataSource.getRepository(Dashboard).find({
    where: { companyId: cid },
    order: { updatedAt: "DESC" },
  });
  // Count cards in one round-trip so the index doesn't N+1.
  const ids = rows.map((d) => d.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const grouped = await AppDataSource.getRepository(DashboardCard)
      .createQueryBuilder("c")
      .select("c.dashboardId", "id")
      .addSelect("COUNT(*)", "n")
      .where("c.dashboardId IN (:...ids)", { ids })
      .groupBy("c.dashboardId")
      .getRawMany<{ id: string; n: string }>();
    for (const r of grouped) counts.set(r.id, Number(r.n));
  }
  res.json(
    rows.map((d) => ({
      ...serializeDashboard(d),
      cardCount: counts.get(d.id) ?? 0,
    })),
  );
});

const createDashboardSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

exploreRouter.post(
  "/explore/dashboards",
  validateBody(createDashboardSchema),
  async (req, res) => {
    const { cid } = params(req);
    const body = req.body as z.infer<typeof createDashboardSchema>;
    const repo = AppDataSource.getRepository(Dashboard);
    const slug = await uniqueDashboardSlug(cid, body.title);
    const row = repo.create({
      companyId: cid,
      title: body.title,
      slug,
      description: body.description ?? "",
      createdById: req.userId ?? null,
      createdByEmployeeId: null,
    });
    await repo.save(row);
    const granted = await grantDashboardToAllEmployees(cid, row.id);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "dashboard.create",
      targetType: "dashboard",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { grantedToEmployees: granted },
    });
    res.status(201).json(serializeDashboard(row));
  },
);

async function loadDashboard(
  companyId: string,
  slug: string,
): Promise<Dashboard | null> {
  return AppDataSource.getRepository(Dashboard).findOneBy({ companyId, slug });
}

exploreRouter.get("/explore/dashboards/:slug", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadDashboard(cid, slug);
  if (!row) return res.status(404).json({ error: "Dashboard not found" });
  const cards = await AppDataSource.getRepository(DashboardCard).find({
    where: { dashboardId: row.id },
    order: { y: "ASC", x: "ASC" },
  });
  const chartIds = [...new Set(cards.map((c) => c.chartId))];
  const charts = chartIds.length
    ? await AppDataSource.getRepository(Chart).find({
        where: { id: In(chartIds), companyId: cid },
      })
    : [];
  res.json({
    ...serializeDashboard(row),
    cards: cards.map(serializeCard),
    charts: charts.map(serializeChart),
  });
});

const patchDashboardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

exploreRouter.patch(
  "/explore/dashboards/:slug",
  validateBody(patchDashboardSchema),
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadDashboard(cid, slug);
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    const body = req.body as z.infer<typeof patchDashboardSchema>;
    if (body.title !== undefined) row.title = body.title;
    if (body.description !== undefined) row.description = body.description;
    await AppDataSource.getRepository(Dashboard).save(row);
    res.json(serializeDashboard(row));
  },
);

exploreRouter.delete("/explore/dashboards/:slug", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadDashboard(cid, slug);
  if (!row) return res.status(404).json({ error: "Dashboard not found" });
  await AppDataSource.getRepository(DashboardCard).delete({ dashboardId: row.id });
  await deleteGrantsForDashboard(row.id);
  await deleteTagAssignments("dashboard", row.id);
  await AppDataSource.getRepository(Dashboard).delete({ id: row.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "dashboard.delete",
    targetType: "dashboard",
    targetId: row.id,
    targetLabel: row.title,
  });
  res.json({ ok: true });
});

// ---------- Dashboard cards ----------

const createCardSchema = z.object({
  chartId: z.string().uuid(),
  x: z.number().int().min(0).max(11).optional(),
  y: z.number().int().min(0).max(10_000).optional(),
  w: z.number().int().min(1).max(12).optional(),
  h: z.number().int().min(1).max(40).optional(),
  titleOverride: z.string().max(200).optional(),
});

exploreRouter.post(
  "/explore/dashboards/:slug/cards",
  validateBody(createCardSchema),
  async (req, res) => {
    const { cid, slug } = params(req);
    const dashboard = await loadDashboard(cid, slug);
    if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });
    const body = req.body as z.infer<typeof createCardSchema>;
    const chart = await AppDataSource.getRepository(Chart).findOneBy({
      id: body.chartId,
      companyId: cid,
    });
    if (!chart) return res.status(400).json({ error: "Unknown chart" });

    // Default placement: append to the bottom of the grid so a freshly
    // added card doesn't overlap an existing one. New row is `maxY + maxH`.
    let defaultY = 0;
    if (body.y === undefined) {
      const existing = await AppDataSource.getRepository(DashboardCard).find({
        where: { dashboardId: dashboard.id },
        order: { y: "DESC" },
        take: 12,
      });
      defaultY = existing.reduce((m, c) => Math.max(m, c.y + c.h), 0);
    }

    const repo = AppDataSource.getRepository(DashboardCard);
    const row = repo.create({
      dashboardId: dashboard.id,
      chartId: chart.id,
      x: body.x ?? 0,
      y: body.y ?? defaultY,
      w: body.w ?? 6,
      h: body.h ?? 4,
      titleOverride: body.titleOverride ?? "",
    });
    await repo.save(row);
    res.status(201).json(serializeCard(row));
  },
);

const patchCardSchema = z.object({
  x: z.number().int().min(0).max(11).optional(),
  y: z.number().int().min(0).max(10_000).optional(),
  w: z.number().int().min(1).max(12).optional(),
  h: z.number().int().min(1).max(40).optional(),
  titleOverride: z.string().max(200).optional(),
});

exploreRouter.patch(
  "/explore/dashboards/:slug/cards/:cardId",
  validateBody(patchCardSchema),
  async (req, res) => {
    const { cid, slug, cardId } = params(req);
    const dashboard = await loadDashboard(cid, slug);
    if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });
    const repo = AppDataSource.getRepository(DashboardCard);
    const card = await repo.findOneBy({ id: cardId, dashboardId: dashboard.id });
    if (!card) return res.status(404).json({ error: "Card not found" });
    const body = req.body as z.infer<typeof patchCardSchema>;
    if (body.x !== undefined) card.x = body.x;
    if (body.y !== undefined) card.y = body.y;
    if (body.w !== undefined) card.w = body.w;
    if (body.h !== undefined) card.h = body.h;
    if (body.titleOverride !== undefined) card.titleOverride = body.titleOverride;
    await repo.save(card);
    res.json(serializeCard(card));
  },
);

exploreRouter.delete(
  "/explore/dashboards/:slug/cards/:cardId",
  async (req, res) => {
    const { cid, slug, cardId } = params(req);
    const dashboard = await loadDashboard(cid, slug);
    if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });
    const repo = AppDataSource.getRepository(DashboardCard);
    const card = await repo.findOneBy({ id: cardId, dashboardId: dashboard.id });
    if (!card) return res.status(404).json({ error: "Card not found" });
    await repo.delete({ id: card.id });
    res.json({ ok: true });
  },
);

// ---------- Grants ----------
//
// Two near-identical shapes — one per row kind. Charts and Dashboards
// each carry their own grant table; an employee needs `read` on a chart
// to run it through MCP and `write` to edit / delete. Humans (members)
// bypass these gates entirely; they only govern the AI surface.

const ACCESS_LEVEL_ENUM = CHART_ACCESS_LEVELS as [string, ...string[]];

type EmployeeRef = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

type ChartGrantWithEmployee = EmployeeChartGrant & {
  employee: EmployeeRef | null;
};
type DashboardGrantWithEmployee = EmployeeDashboardGrant & {
  employee: EmployeeRef | null;
};

async function hydrateChartGrants(
  companyId: string,
  grants: EmployeeChartGrant[],
): Promise<ChartGrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(empIds), companyId },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return grants.map((g) => {
    const e = byId.get(g.employeeId);
    return Object.assign(g, {
      employee: e
        ? {
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            avatarKey: e.avatarKey ?? null,
          }
        : null,
    });
  });
}

async function hydrateDashboardGrants(
  companyId: string,
  grants: EmployeeDashboardGrant[],
): Promise<DashboardGrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(empIds), companyId },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return grants.map((g) => {
    const e = byId.get(g.employeeId);
    return Object.assign(g, {
      employee: e
        ? {
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            avatarKey: e.avatarKey ?? null,
          }
        : null,
    });
  });
}

// Chart grants

exploreRouter.get("/explore/charts/:slug/grants", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadChart(cid, slug);
  if (!row) return res.status(404).json({ error: "Chart not found" });
  const direct = await listDirectChartGrants(row.id);
  res.json({ direct: await hydrateChartGrants(cid, direct) });
});

exploreRouter.get("/explore/charts/:slug/grant-candidates", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadChart(cid, slug);
  if (!row) return res.status(404).json({ error: "Chart not found" });
  const [emps, direct] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
      order: { createdAt: "ASC" },
    }),
    listDirectChartGrants(row.id),
  ]);
  const grantedSet = new Set(direct.map((g) => g.employeeId));
  res.json(
    emps.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      role: e.role,
      avatarKey: e.avatarKey ?? null,
      alreadyGranted: grantedSet.has(e.id),
    })),
  );
});

const createChartGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVEL_ENUM).optional(),
});

exploreRouter.post(
  "/explore/charts/:slug/grants",
  validateBody(createChartGrantSchema),
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadChart(cid, slug);
    if (!row) return res.status(404).json({ error: "Chart not found" });
    const body = req.body as z.infer<typeof createChartGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertChartGrant(
      emp.id,
      row.id,
      (body.accessLevel ?? "read") as ChartAccessLevel,
    );
    const [hydrated] = await hydrateChartGrants(cid, [grant]);
    res.json(hydrated);
  },
);

const patchChartGrantSchema = z.object({
  accessLevel: z.enum(ACCESS_LEVEL_ENUM),
});

exploreRouter.patch(
  "/explore/charts/:slug/grants/:grantId",
  validateBody(patchChartGrantSchema),
  async (req, res) => {
    const { cid, slug, grantId } = params(req);
    const row = await loadChart(cid, slug);
    if (!row) return res.status(404).json({ error: "Chart not found" });
    const repo = AppDataSource.getRepository(EmployeeChartGrant);
    const grant = await repo.findOneBy({ id: grantId, chartId: row.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const body = req.body as z.infer<typeof patchChartGrantSchema>;
    grant.accessLevel = body.accessLevel as ChartAccessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateChartGrants(cid, [grant]);
    res.json(hydrated);
  },
);

exploreRouter.delete(
  "/explore/charts/:slug/grants/:grantId",
  async (req, res) => {
    const { cid, slug, grantId } = params(req);
    const row = await loadChart(cid, slug);
    if (!row) return res.status(404).json({ error: "Chart not found" });
    const repo = AppDataSource.getRepository(EmployeeChartGrant);
    const grant = await repo.findOneBy({ id: grantId, chartId: row.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await repo.delete({ id: grant.id });
    res.json({ ok: true });
  },
);

// Dashboard grants

exploreRouter.get("/explore/dashboards/:slug/grants", async (req, res) => {
  const { cid, slug } = params(req);
  const row = await loadDashboard(cid, slug);
  if (!row) return res.status(404).json({ error: "Dashboard not found" });
  const direct = await listDirectDashboardGrants(row.id);
  res.json({ direct: await hydrateDashboardGrants(cid, direct) });
});

exploreRouter.get(
  "/explore/dashboards/:slug/grant-candidates",
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadDashboard(cid, slug);
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    const [emps, direct] = await Promise.all([
      AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: cid },
        order: { createdAt: "ASC" },
      }),
      listDirectDashboardGrants(row.id),
    ]);
    const grantedSet = new Set(direct.map((g) => g.employeeId));
    res.json(
      emps.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        role: e.role,
        avatarKey: e.avatarKey ?? null,
        alreadyGranted: grantedSet.has(e.id),
      })),
    );
  },
);

exploreRouter.post(
  "/explore/dashboards/:slug/grants",
  validateBody(createChartGrantSchema),
  async (req, res) => {
    const { cid, slug } = params(req);
    const row = await loadDashboard(cid, slug);
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    const body = req.body as z.infer<typeof createChartGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertDashboardGrant(
      emp.id,
      row.id,
      (body.accessLevel ?? "read") as ChartAccessLevel,
    );
    const [hydrated] = await hydrateDashboardGrants(cid, [grant]);
    res.json(hydrated);
  },
);

exploreRouter.patch(
  "/explore/dashboards/:slug/grants/:grantId",
  validateBody(patchChartGrantSchema),
  async (req, res) => {
    const { cid, slug, grantId } = params(req);
    const row = await loadDashboard(cid, slug);
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    const repo = AppDataSource.getRepository(EmployeeDashboardGrant);
    const grant = await repo.findOneBy({ id: grantId, dashboardId: row.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const body = req.body as z.infer<typeof patchChartGrantSchema>;
    grant.accessLevel = body.accessLevel as ChartAccessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateDashboardGrants(cid, [grant]);
    res.json(hydrated);
  },
);

exploreRouter.delete(
  "/explore/dashboards/:slug/grants/:grantId",
  async (req, res) => {
    const { cid, slug, grantId } = params(req);
    const row = await loadDashboard(cid, slug);
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    const repo = AppDataSource.getRepository(EmployeeDashboardGrant);
    const grant = await repo.findOneBy({ id: grantId, dashboardId: row.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await repo.delete({ id: grant.id });
    res.json({ ok: true });
  },
);

// ---------- Catalog metadata for the UI ----------

exploreRouter.get("/explore/meta", (_req, res) => {
  res.json({
    providers: EXPLORE_PROVIDERS,
    vizTypes: VIZ_TYPES,
    rowCap: 5000,
    statementTimeoutMs: 30_000,
  });
});

