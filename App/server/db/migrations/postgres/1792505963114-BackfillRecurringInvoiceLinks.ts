import { MigrationInterface, QueryRunner } from "typeorm";

type Link = { invoiceId: string; recurringInvoiceId: string; companyId: string };

type AuditRow = {
  id: string;
  companyId: string;
  targetId: string | null;
  targetLabel: string;
  actorKind: string;
  actorUserId: string | null;
  metadataJson: string;
  createdAt: Date;
};

/** The two audit rows of one generated invoice are written milliseconds apart. */
const PAIR_WINDOW_MS = 60_000;
const UPDATE_CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * invoice recorded its schedule (`invoices."recurringInvoiceId"`, added by the
 * sibling RecurringInvoiceLinks migration), so a schedule's page lists them.
 *
 * It links only what the database proves, from three records, and the first
 * proof wins:
 *   1. a scheduled run names the invoice it created
 *      (`recurring_invoice_runs."invoiceId"`, kept since runs were recorded);
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
export class BackfillRecurringInvoiceLinks1792505963114 implements MigrationInterface {
  name = "BackfillRecurringInvoiceLinks1792505963114";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const links = new Map<string, Link>();
    const claim = (rows: Link[]) => {
      for (const row of rows) if (!links.has(row.invoiceId)) links.set(row.invoiceId, row);
    };

    claim(
      await queryRunner.query(
        `SELECT "run"."invoiceId" AS "invoiceId", "run"."recurringInvoiceId" AS "recurringInvoiceId", "run"."companyId" AS "companyId"
         FROM "recurring_invoice_runs" "run"
         INNER JOIN "recurring_invoices" "ri" ON "ri"."id"::text = "run"."recurringInvoiceId" AND "ri"."companyId" = "run"."companyId"
         WHERE "run"."invoiceId" IS NOT NULL
         ORDER BY "run"."scheduledFor"`,
      ),
    );
    claim(await this.auditPairs(queryRunner));
    claim(
      await queryRunner.query(
        `SELECT "inv"."id"::text AS "invoiceId", "ri"."id"::text AS "recurringInvoiceId", "ri"."companyId" AS "companyId"
         FROM "recurring_invoices" "ri"
         INNER JOIN "invoices" "inv" ON "inv"."companyId" = "ri"."companyId" AND "inv"."slug" = "ri"."lastInvoiceSlug"
         WHERE "ri"."lastInvoiceSlug" > '' AND "inv"."createdAt" >= "ri"."createdAt"`,
      ),
    );

    const bySchedule = new Map<string, Link[]>();
    for (const link of links.values()) {
      if (!UUID.test(link.invoiceId)) continue;
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
          `UPDATE "invoices" SET "recurringInvoiceId" = $1
           WHERE "companyId" = $2 AND "recurringInvoiceId" IS NULL AND "id" = ANY($3::uuid[])`,
          [recurringInvoiceId, companyId, ids],
        );
      }
    }
  }

  /** Source 2: pair each schedule's run audit row with its invoice's. */
  private async auditPairs(queryRunner: QueryRunner): Promise<Link[]> {
    // Driven from the schedules so each lookup is a range on the
    // ("companyId", "targetType", "targetId", "createdAt") index.
    const runs: AuditRow[] = await queryRunner.query(
      `SELECT "a"."id"::text AS "id", "a"."companyId" AS "companyId", "a"."targetId" AS "targetId",
              "a"."targetLabel" AS "targetLabel", "a"."actorKind" AS "actorKind",
              "a"."actorUserId" AS "actorUserId", "a"."metadataJson" AS "metadataJson",
              "a"."createdAt" AS "createdAt"
       FROM "recurring_invoices" "ri"
       INNER JOIN "audit_events" "a"
         ON "a"."companyId" = "ri"."companyId" AND "a"."targetType" = 'recurring_invoice' AND "a"."targetId" = "ri"."id"::text
       WHERE "a"."action" = 'finance.recurring_invoice.run'
       ORDER BY "a"."createdAt"`,
    );
    const used = new Set<string>();
    const links: Link[] = [];
    for (const run of runs) {
      if (!run.targetId) continue;
      const total = metadataOf(run.metadataJson)?.totalCents;
      // Audit rows are stamped to the millisecond in the order they are
      // written, so the newest invoice row at or before the run row is its pair.
      const candidates: AuditRow[] = await queryRunner.query(
        `SELECT "a"."id"::text AS "id", "a"."targetId" AS "targetId", "a"."actorKind" AS "actorKind",
                "a"."actorUserId" AS "actorUserId", "a"."metadataJson" AS "metadataJson",
                "a"."createdAt" AS "createdAt"
         FROM "audit_events" "a"
         WHERE "a"."companyId" = $1 AND "a"."createdAt" >= $2 AND "a"."createdAt" <= $3
           AND "a"."action" = 'finance.invoice.create' AND "a"."targetType" = 'invoice'
         ORDER BY "a"."createdAt" DESC`,
        [run.companyId, new Date(run.createdAt.getTime() - PAIR_WINDOW_MS), run.createdAt],
      );
      const matches = candidates.filter((row) => {
        if (used.has(row.id) || !row.targetId) return false;
        if (row.actorKind !== run.actorKind || row.actorUserId !== run.actorUserId) return false;
        const metadata = metadataOf(row.metadataJson);
        return metadata?.schedule === run.targetLabel && metadata.totalCents === total;
      });
      const [match, next] = matches;
      // Two look-alike invoice rows in the same millisecond leave nothing to
      // order them by here, so neither is linked rather than one guessed.
      if (!match?.targetId || next?.createdAt.getTime() === match.createdAt.getTime()) continue;
      used.add(match.id);
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
