import { AppDataSource } from "../db/datasource.js";
import { Chart } from "../db/entities/Chart.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { parseBaseChartQuery, type BaseChartQuery } from "../../shared/baseChartQuery.js";
import { isExploreProvider, runSqlAgainstConnection, type QueryResult } from "./explore.js";
import {
  assertBaseChartQuery,
  BaseChartError,
  runBaseChartQuery,
  type BaseChartRunOptions,
} from "./baseCharts.js";

/**
 * A Chart reads one of two sources: SQL over a database Connection, or a
 * structured query over one of the company's own Bases. Everything that runs
 * a saved Chart — the editor, Dashboards, Goals, the AI tools — goes through
 * {@link runChart}, and everything that sets what a Chart reads goes through
 * {@link applyChartSource}, so the two kinds cannot drift apart.
 */

export class ChartSourceError extends Error {}

export type ChartSourceInput = {
  connectionId?: string;
  sql?: string;
  baseId?: string;
  baseQuery?: BaseChartQuery;
};

export type ChartSource = "connection" | "base";

export function chartSource(chart: Pick<Chart, "baseId">): ChartSource {
  return chart.baseId ? "base" : "connection";
}

function asSourceError(error: unknown): never {
  if (error instanceof BaseChartError) throw new ChartSourceError(error.message);
  throw error;
}

/**
 * Point a new or existing Chart at the source `input` names, checked inside
 * the Chart's company. Fields left out keep their values; naming the other
 * kind of source switches the Chart over and clears what it read before.
 * Throws {@link ChartSourceError} with a message fit to show as-is.
 */
export async function applyChartSource(
  row: Chart,
  input: ChartSourceInput,
  opts: { forEmployee?: boolean } = {},
): Promise<void> {
  const toBase = input.baseId !== undefined || input.baseQuery !== undefined;
  const toSql = input.connectionId !== undefined || input.sql !== undefined;
  if (toBase && toSql) {
    throw new ChartSourceError("A chart reads either a database Connection or a Base, not both");
  }

  if (toBase) {
    const baseId = input.baseId ?? row.baseId;
    const query = input.baseQuery ?? (row.baseId ? parseBaseChartQuery(row.baseQueryJson) : null);
    if (!baseId) throw new ChartSourceError("Choose the Base the chart reads");
    if (!query) throw new ChartSourceError("Choose the table the chart reads");
    await assertBaseChartQuery(row.companyId, baseId, query, opts).catch(asSourceError);
    row.baseId = baseId;
    row.baseQueryJson = JSON.stringify(query);
    row.connectionId = null;
    row.sql = "";
    return;
  }

  if (toSql) {
    const connectionId = input.connectionId ?? row.connectionId;
    const sql = input.sql ?? (row.connectionId ? row.sql : "");
    if (!connectionId) throw new ChartSourceError("Choose the database Connection the chart reads");
    if (!sql.trim()) throw new ChartSourceError("SQL is required");
    if (input.connectionId !== undefined) {
      const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: connectionId,
        companyId: row.companyId,
      });
      if (!connection) throw new ChartSourceError("Unknown connection");
      if (!isExploreProvider(connection.provider)) {
        throw new ChartSourceError("Connection is not a supported Explore source");
      }
    }
    row.connectionId = connectionId;
    row.sql = sql;
    row.baseId = null;
    row.baseQueryJson = null;
    return;
  }

  if (!row.connectionId && !row.baseId) {
    throw new ChartSourceError("Choose a database Connection and SQL, or a Base and a table");
  }
}

/**
 * Run a saved Chart over whichever source it reads. A missing source or an
 * unanswerable Base query throws {@link ChartSourceError}; a database's own
 * error passes through as the driver raised it, as it always has.
 */
export async function runChart(chart: Chart, opts: BaseChartRunOptions = {}): Promise<QueryResult> {
  if (chart.baseId) {
    const query = parseBaseChartQuery(chart.baseQueryJson);
    if (!query) {
      throw new ChartSourceError(
        "The chart's Base query can't be read. Open the chart and choose its table again.",
      );
    }
    return runBaseChartQuery(chart.companyId, chart.baseId, query, opts).catch(asSourceError);
  }
  const connection = chart.connectionId
    ? await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: chart.connectionId,
        companyId: chart.companyId,
      })
    : null;
  if (!connection) throw new ChartSourceError("The chart's database Connection no longer exists");
  return runSqlAgainstConnection(connection, chart.sql, { maxRows: opts.maxRows });
}
