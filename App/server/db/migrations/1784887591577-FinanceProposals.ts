import { MigrationInterface, QueryRunner } from "typeorm";

export class FinanceProposals1784887591577 implements MigrationInterface {
    name = 'FinanceProposals1784887591577'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "finance_proposals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('journal_entry'), "status" varchar NOT NULL DEFAULT ('pending'), "proposedByType" varchar NOT NULL DEFAULT ('human'), "proposedById" varchar, "proposedByLabel" varchar, "title" varchar NOT NULL, "summary" text, "payloadJson" text NOT NULL, "resultJson" text, "appliedEntryId" varchar, "errorMessage" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "decidedAt" datetime, "decidedByUserId" varchar, "reviewNote" text)`);
        await queryRunner.query(`CREATE INDEX "IDX_8da27bb4588fd50db1e364a9a1" ON "finance_proposals" ("appliedEntryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_064a704ce7a08db8e337b4d016" ON "finance_proposals" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_064a704ce7a08db8e337b4d016"`);
        await queryRunner.query(`DROP INDEX "IDX_8da27bb4588fd50db1e364a9a1"`);
        await queryRunner.query(`DROP TABLE "finance_proposals"`);
    }

}
