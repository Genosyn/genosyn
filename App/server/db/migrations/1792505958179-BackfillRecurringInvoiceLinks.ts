import { MigrationInterface, QueryRunner } from "typeorm";

type Link = { invoiceId: string; recurringInvoiceId: string; companyId: string };

type AuditRow = {
  seq: number;
  companyId: string;
  targetId: string | null;
  targetLabel: string;
  actorKind: string;
  actorUserId: string | null;
  metadataJson: string;
  createdAt: string;
};

/** The two audit rows of one generated invoice are written milliseconds apart. */
const PAIR_WINDOW_SECONDS = 60;
const UPDATE_CHUNK = 200;

function metadataOf(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Links the invoices that recurring invoice schedules created before each
 * invoice recorded its schedule (`invoices.recurringInvoiceId`, added by the
 * sibling RecurringInvoiceLinks migration), so a schedule's page lists them.
 *
 * It links only what the database proves, from three records, and the first
 * proof wins:
 *   1. a scheduled run names the invoice it created
 *      (`recurring_invoice_runs.invoiceId`, kept since runs were recorded);
 *   2. every invoice a schedule created since History shipped, Run now
 *      included, left two audit rows back to back: `finance.invoice.create` on
 *      the invoice, naming the schedule, then `finance.recurring_invoice.run`
 *      on the schedule. Each run row takes the closest invoice row before it
 *      with the same company, actor, schedule name and total. No other path
 *      writes an invoice-create row that names a schedule;
 *   3. a schedule points at the last invoice it created (`lastInvoiceSlug`),
 *      which can only be an invoice created after the schedule was.
 * An invoice none of them proves stays unlinked rather than guessed at, and
 * nothing is linked to a schedule that no longer exists.
 *
 * Hand-rolled because there's no schema diff for migration:generate to notice.
 */
export class BackfillRecurringInvoiceLinks1792505958179 implements MigrationInterface {
  name = "BackfillRecurringInvoiceLinks1792505958179";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const links = new Map<string, Link>();
    const claim = (rows: Link[]) => {
      for (const row of rows) if (!links.has(row.invoiceId)) links.set(row.invoiceId, row);
    };

    claim(
      await queryRunner.query(
        `SELECT "run"."invoiceId" AS "invoiceId", "run"."recurringInvoiceId" AS "recurringInvoiceId", "run"."companyId" AS "companyId"
         FROM "recurring_invoice_runs" "run"
         INNER JOIN "recurring_invoices" "ri" ON "ri"."id" = "run"."recurringInvoiceId" AND "ri"."companyId" = "run"."companyId"
         WHERE "run"."invoiceId" IS NOT NULL
         ORDER BY "run"."scheduledFor"`,
      ),
    );
    claim(await this.auditPairs(queryRunner));
    claim(
      await queryRunner.query(
        `SELECT "inv"."id" AS "invoiceId", "ri"."id" AS "recurringInvoiceId", "ri"."companyId" AS "companyId"
         FROM "recurring_invoices" "ri"
         INNER JOIN "invoices" "inv" ON "inv"."companyId" = "ri"."companyId" AND "inv"."slug" = "ri"."lastInvoiceSlug"
         WHERE "ri"."lastInvoiceSlug" > '' AND "inv"."createdAt" >= "ri"."createdAt"`,
      ),
    );

    const bySchedule = new Map<string, Link[]>();
    for (const link of links.values()) {
      const key = `${link.companyId}\u0000${link.recurringInvoiceId}`;
      bySchedule.set(key, [...(bySchedule.get(key) ?? []), link]);
    }
    for (const group of bySchedule.values()) {
      const { companyId, recurringInvoiceId } = group[0];
      for (let i = 0; i < group.length; i += UPDATE_CHUNK) {
        const ids = group.slice(i, i + UPDATE_CHUNK).map((link) => link.invoiceId);
        // The company test keeps a link inside one company; the null test
        // leaves any invoice already linked as it is.
        await queryRunner.query(
          `UPDATE "invoices" SET "recurringInvoiceId" = ?
           WHERE "companyId" = ? AND "recurringInvoiceId" IS NULL AND "id" IN (${ids.map(() => "?").join(", ")})`,
          [recurringInvoiceId, companyId, ...ids],
        );
      }
    }
  }

  /** Source 2: pair each schedule's run audit row with its invoice's. */
  private async auditPairs(queryRunner: QueryRunner): Promise<Link[]> {
    // Driven from the schedules so each lookup is a range on the
    // (companyId, targetType, targetId, createdAt) index.
    const runs: AuditRow[] = await queryRunner.query(
      `SELECT "a".rowid AS "seq", "a"."companyId" AS "companyId", "a"."targetId" AS "targetId",
              "a"."targetLabel" AS "targetLabel", "a"."actorKind" AS "actorKind",
              "a"."actorUserId" AS "actorUserId", "a"."metadataJson" AS "metadataJson",
              "a"."createdAt" AS "createdAt"
       FROM "recurring_invoices" "ri"
       INNER JOIN "audit_events" "a"
         ON "a"."companyId" = "ri"."companyId" AND "a"."targetType" = 'recurring_invoice' AND "a"."targetId" = "ri"."id"
       WHERE "a"."action" = 'finance.recurring_invoice.run'
       ORDER BY "a".rowid`,
    );
    const used = new Set<number>();
    const links: Link[] = [];
    for (const run of runs) {
      if (!run.targetId) continue;
      const total = metadataOf(run.metadataJson)?.totalCents;
      // rowid is insertion order, so "before" is exact even within one
      // millisecond; the time bounds only keep the scan on the index.
      const candidates: AuditRow[] = await queryRunner.query(
        `SELECT "a".rowid AS "seq", "a"."targetId" AS "targetId", "a"."actorKind" AS "actorKind",
                "a"."actorUserId" AS "actorUserId", "a"."metadataJson" AS "metadataJson"
         FROM "audit_events" "a"
         WHERE "a"."companyId" = ?
           AND "a"."createdAt" >= datetime(?, '-${PAIR_WINDOW_SECONDS} seconds') AND "a"."createdAt" <= ?
           AND "a"."action" = 'finance.invoice.create' AND "a"."targetType" = 'invoice'
           AND "a".rowid < ?
         ORDER BY "a".rowid DESC`,
        [run.companyId, run.createdAt, run.createdAt, run.seq],
      );
      const match = candidates.find((row) => {
        if (used.has(row.seq) || !row.targetId) return false;
        if (row.actorKind !== run.actorKind || row.actorUserId !== run.actorUserId) return false;
        const metadata = metadataOf(row.metadataJson);
        return metadata?.schedule === run.targetLabel && metadata.totalCents === total;
      });
      if (!match?.targetId) continue;
      used.add(match.seq);
      links.push({
        invoiceId: match.targetId,
        recurringInvoiceId: run.targetId,
        companyId: run.companyId,
      });
    }
    return links;
  }

  public async down(): Promise<void> {
    // Intentionally irreversible. Once this has run, a backfilled link is
    // indistinguishable from one a schedule wrote itself, so clearing "the
    // backfilled ones" would take real links with it. Rolling back the schema
    // drops the column; roll forward instead.
  }
}
