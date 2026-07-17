import { MigrationInterface, QueryRunner } from "typeorm";

export class AdSpendEvents1784277379724 implements MigrationInterface {
    name = 'AdSpendEvents1784277379724'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ad_spend_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "employeeId" varchar NOT NULL DEFAULT (''), "platform" varchar NOT NULL, "adAccountRef" varchar NOT NULL DEFAULT (''), "campaignRef" varchar NOT NULL DEFAULT (''), "toolName" varchar NOT NULL, "mutationKind" varchar NOT NULL, "amountMinor" integer NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT (''), "approvalId" varchar, "summary" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2237cf97aa5fc427e0f067ae3d" ON "ad_spend_events" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_33356268df0824764a09cf8554" ON "ad_spend_events" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9ca65d02a281dd57793e750444" ON "ad_spend_events" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9ca65d02a281dd57793e750444"`);
        await queryRunner.query(`DROP INDEX "IDX_33356268df0824764a09cf8554"`);
        await queryRunner.query(`DROP INDEX "IDX_2237cf97aa5fc427e0f067ae3d"`);
        await queryRunner.query(`DROP TABLE "ad_spend_events"`);
    }

}
