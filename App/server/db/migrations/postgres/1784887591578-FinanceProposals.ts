import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `FinanceProposals1784887591577`
 * migration — the `finance_proposals` table (M33 A3, the finance-proposal
 * spine / maker-checker for journal entries).
 *
 * Column types follow the Postgres snapshot's conventions. The index names are
 * copied byte-for-byte from the sqlite migration (TypeORM derives them from a
 * dialect-independent hash) and the PK name was computed with the same naming
 * strategy (verified against existing tables), so a future migration:generate
 * against Postgres sees no drift.
 */
export class FinanceProposals1784887591578 implements MigrationInterface {
  name = "FinanceProposals1784887591578";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "finance_proposals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'journal_entry', "status" character varying NOT NULL DEFAULT 'pending', "proposedByType" character varying NOT NULL DEFAULT 'human', "proposedById" character varying, "proposedByLabel" character varying, "title" character varying NOT NULL, "summary" text, "payloadJson" text NOT NULL, "resultJson" text, "appliedEntryId" character varying, "errorMessage" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "decidedAt" TIMESTAMP WITH TIME ZONE, "decidedByUserId" character varying, "reviewNote" text, CONSTRAINT "PK_df3f35275300aa5247e033d61a9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8da27bb4588fd50db1e364a9a1" ON "finance_proposals" ("appliedEntryId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_064a704ce7a08db8e337b4d016" ON "finance_proposals" ("companyId", "status") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_064a704ce7a08db8e337b4d016"`);
    await queryRunner.query(`DROP INDEX "IDX_8da27bb4588fd50db1e364a9a1"`);
    await queryRunner.query(`DROP TABLE "finance_proposals"`);
  }
}
