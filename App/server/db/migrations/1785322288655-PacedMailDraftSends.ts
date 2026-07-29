import { MigrationInterface, QueryRunner } from "typeorm";

export class PacedMailDraftSends1785322288655 implements MigrationInterface {
    name = 'PacedMailDraftSends1785322288655'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_draft_send_batches" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "total" integer NOT NULL DEFAULT (0), "sent" integer NOT NULL DEFAULT (0), "failed" integer NOT NULL DEFAULT (0), "itemsJson" text NOT NULL DEFAULT ('[]'), "nextSendAt" datetime, "finishedAt" datetime, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f14c6c588aeb18540a42afc4f2" ON "mail_draft_send_batches" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_24d97855dae66da9ae8f9c92a5" ON "mail_draft_send_batches" ("companyId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_24d97855dae66da9ae8f9c92a5"`);
        await queryRunner.query(`DROP INDEX "IDX_f14c6c588aeb18540a42afc4f2"`);
        await queryRunner.query(`DROP TABLE "mail_draft_send_batches"`);
    }

}
