import { Between, In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Base } from "../../db/entities/Base.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { Chart } from "../../db/entities/Chart.js";
import { EmployeeBaseGrant } from "../../db/entities/EmployeeBaseGrant.js";
import { EmployeeChartGrant } from "../../db/entities/EmployeeChartGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { Note } from "../../db/entities/Note.js";
import { Notebook } from "../../db/entities/Notebook.js";
import { Resource } from "../../db/entities/Resource.js";
import { redactSensitiveText } from "../approvalRedaction.js";
import { UUID_RE } from "../bases.js";
import { listAccessibleNoteIds } from "../notes.js";
import {
  PROACTIVE_SECTION_LIMIT,
  type ProactiveOpportunity,
  type ProactiveOpportunitySection,
} from "./opportunities.js";

export const PROACTIVE_KNOWLEDGE_WINDOW_DAYS = 7;
const take = PROACTIVE_SECTION_LIMIT + 1;
const title = (value: string) => redactSensitiveText(value).slice(0, 120);
const section = (items: ProactiveOpportunity[]): ProactiveOpportunitySection => ({
  items: items.slice(0, PROACTIVE_SECTION_LIMIT),
  truncated: items.length > PROACTIVE_SECTION_LIMIT,
});

function rawDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  // SQLite's raw aggregate timestamps omit a zone; its stored dates are UTC.
  return new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? value.replace(" ", "T") + "Z" : value);
}

/** Read cues for relevant knowledge changes; age alone never implies a needed edit. */
export async function getKnowledgeOpportunities(
  companyId: string,
  employeeId: string,
  now = new Date(),
): Promise<Record<string, ProactiveOpportunitySection>> {
  if (
    !UUID_RE.test(employeeId) ||
    !(await AppDataSource.getRepository(AIEmployee).existsBy({ id: employeeId, companyId }))
  ) {
    throw new Error("AI Employee not found");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid opportunity time");
  const since = new Date(now.getTime() - PROACTIVE_KNOWLEDGE_WINDOW_DAYS * 86_400_000);
  const noteIds = [...(await listAccessibleNoteIds(companyId, employeeId))];
  const [notes, tables, charts, resources] = await Promise.all([
    noteIds.length
      ? AppDataSource.getRepository(Note)
          .createQueryBuilder("note")
          .select(["note.id", "note.title", "note.slug", "note.updatedAt"])
          .innerJoin(
            Notebook,
            "notebook",
            "CAST(notebook.id AS text) = note.notebookId AND notebook.companyId = :companyId",
            { companyId },
          )
          .where({
            companyId,
            id: In(noteIds),
            archivedAt: IsNull(),
            updatedAt: Between(since, now),
          })
          .orderBy("note.updatedAt", "DESC")
          .addOrderBy("note.id", "ASC")
          .take(take)
          .getMany()
      : Promise.resolve([]),
    AppDataSource.getRepository(BaseTable)
      .createQueryBuilder("baseTable")
      .innerJoin(
        Base,
        "base",
        "CAST(base.id AS text) = baseTable.baseId AND base.companyId = :companyId",
        { companyId },
      )
      .innerJoin(
        EmployeeBaseGrant,
        "baseGrant",
        "baseGrant.baseId = CAST(base.id AS text) AND baseGrant.employeeId = :employeeId",
        { employeeId },
      )
      .leftJoin(
        BaseRecord,
        "record",
        "record.tableId = CAST(baseTable.id AS text) AND record.updatedAt <= :now",
        { now },
      )
      .select("baseTable.id", "id")
      .addSelect("baseTable.name", "name")
      .addSelect("baseTable.createdAt", "createdAt")
      .addSelect("base.name", "baseName")
      .addSelect("base.slug", "baseSlug")
      .addSelect("MAX(record.updatedAt)", "recordUpdatedAt")
      .where("baseTable.archivedAt IS NULL AND baseTable.createdAt <= :now", { now })
      .groupBy("baseTable.id")
      .addGroupBy("baseTable.name")
      .addGroupBy("baseTable.createdAt")
      .addGroupBy("base.name")
      .addGroupBy("base.slug")
      .having(
        "(baseTable.createdAt BETWEEN :since AND :now OR MAX(record.updatedAt) BETWEEN :since AND :now)",
        { since, now },
      )
      .orderBy(
        "CASE WHEN MAX(record.updatedAt) > baseTable.createdAt THEN MAX(record.updatedAt) ELSE baseTable.createdAt END",
        "DESC",
      )
      .addOrderBy("baseTable.id", "ASC")
      .limit(take)
      .getRawMany<{
        id: string;
        name: string;
        createdAt: Date | string;
        baseName: string;
        baseSlug: string;
        recordUpdatedAt: Date | string | null;
      }>(),
    AppDataSource.getRepository(Chart)
      .createQueryBuilder("chart")
      .select(["chart.id", "chart.title", "chart.slug", "chart.updatedAt"])
      .innerJoin(
        EmployeeChartGrant,
        "chartGrant",
        "chartGrant.chartId = CAST(chart.id AS text) AND chartGrant.employeeId = :employeeId AND chartGrant.accessLevel IN (:...levels)",
        { employeeId, levels: ["read", "write"] },
      )
      .where("chart.companyId = :companyId AND chart.updatedAt BETWEEN :since AND :now", {
        companyId,
        since,
        now,
      })
      .orderBy("chart.updatedAt", "DESC")
      .addOrderBy("chart.id", "ASC")
      .take(take)
      .getMany(),
    AppDataSource.getRepository(Resource)
      .createQueryBuilder("resource")
      .select([
        "resource.id",
        "resource.title",
        "resource.slug",
        "resource.status",
        "resource.updatedAt",
      ])
      .innerJoin(
        EmployeeResourceGrant,
        "resourceGrant",
        "resourceGrant.resourceId = CAST(resource.id AS text) AND resourceGrant.employeeId = :employeeId AND resourceGrant.accessLevel IN (:...levels)",
        { employeeId, levels: ["read", "edit", "delete"] },
      )
      .where("resource.companyId = :companyId AND resource.updatedAt <= :now", { companyId, now })
      .andWhere(
        "(resource.status = :failed OR (resource.status = :ready AND resource.updatedAt >= :since))",
        { failed: "failed", ready: "ready", since },
      )
      .orderBy("CASE WHEN resource.status = 'failed' THEN 0 ELSE 1 END", "ASC")
      .addOrderBy("resource.updatedAt", "DESC")
      .addOrderBy("resource.id", "ASC")
      // One unique Grant per Resource/employee, so a SQL limit needs no
      // joined-entity pagination wrapper (which cannot order by this CASE).
      .limit(take)
      .getMany(),
  ]);
  return {
    notes: section(
      notes.map((note) => ({
        id: note.id,
        kind: "note",
        title: title(note.title),
        locator: note.slug,
        reason:
          "A granted Note changed recently. Read it only if relevant to your responsibilities; a change is not evidence it needs rewriting.",
        updatedAt: note.updatedAt.toISOString(),
        tools: ["get_note", "search_notes"],
      })),
    ),
    bases: section(
      tables.map((table) => ({
        id: table.id,
        kind: "base_table",
        title: title(`${table.baseName}: ${table.name}`),
        locator: table.baseSlug,
        reason:
          "A granted active Base table is new or has recent record changes. Inspect its schema and relevant rows before deciding whether work is needed.",
        updatedAt: new Date(
          Math.max(
            rawDate(table.createdAt).getTime(),
            table.recordUpdatedAt ? rawDate(table.recordUpdatedAt).getTime() : 0,
          ),
        ).toISOString(),
        tools: ["get_base", "list_base_rows"],
      })),
    ),
    charts: section(
      charts.map((chart) => ({
        id: chart.id,
        kind: "chart",
        title: title(chart.title),
        locator: chart.slug,
        reason:
          "A granted Chart definition changed recently. Review relevant metrics; this does not assert that its data changed or its query failed.",
        updatedAt: chart.updatedAt.toISOString(),
        tools: ["get_chart", "run_chart"],
      })),
    ),
    resources: section(
      resources.map((resource) => ({
        id: resource.id,
        kind: "resource",
        title: title(resource.title),
        locator: resource.slug,
        reason:
          resource.status === "failed"
            ? "This granted Resource has a recorded ingestion failure. Inspect the failure and its relevance before proposing a correction."
            : "A granted Resource became available or changed recently. Read it if it informs your responsibilities; do not duplicate it.",
        updatedAt: resource.updatedAt.toISOString(),
        tools: ["get_resource"],
      })),
    ),
  };
}
