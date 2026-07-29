import { MigrationInterface, QueryRunner } from "typeorm";

export class PacedMailDraftSends1785322330503 implements MigrationInterface {
    name = 'PacedMailDraftSends1785322330503'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_draft_send_batches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "total" integer NOT NULL DEFAULT '0', "sent" integer NOT NULL DEFAULT '0', "failed" integer NOT NULL DEFAULT '0', "itemsJson" text NOT NULL DEFAULT '[]', "nextSendAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_464ccdb65d1394e60047cee44ff" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f14c6c588aeb18540a42afc4f2" ON "mail_draft_send_batches" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_24d97855dae66da9ae8f9c92a5" ON "mail_draft_send_batches" ("companyId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_24d97855dae66da9ae8f9c92a5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f14c6c588aeb18540a42afc4f2"`);
        await queryRunner.query(`DROP TABLE "mail_draft_send_batches"`);
    }

}
