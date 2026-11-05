import { MigrationInterface, QueryRunner } from "typeorm";

export class ProjectIntake1793883740726 implements MigrationInterface {
    name = 'ProjectIntake1793883740726'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_intakes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "projectId" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "whatBelongs" text NOT NULL DEFAULT '', "instruction" text NOT NULL DEFAULT '', "accountIdsJson" text NOT NULL DEFAULT '[]', "assigneeEmployeeId" character varying, "reviewerEmployeeId" character varying, "reviewerUserId" character varying, "replyMode" character varying NOT NULL DEFAULT 'review', "trustedSenders" text NOT NULL DEFAULT '', "updatedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d9fd56584b251bd3553b7b54850" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f3011d35e8f3d4dda6cc9a9884" ON "project_intakes" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6bf941dbb94d502a146ea1bf7f" ON "project_intakes" ("projectId") `);
        await queryRunner.query(`ALTER TABLE "todo_pickups" ADD "trustedSender" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "mail_inbound_analyses" ADD "intakeJson" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_inbound_analyses" DROP COLUMN "intakeJson"`);
        await queryRunner.query(`ALTER TABLE "todo_pickups" DROP COLUMN "trustedSender"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6bf941dbb94d502a146ea1bf7f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f3011d35e8f3d4dda6cc9a9884"`);
        await queryRunner.query(`DROP TABLE "project_intakes"`);
    }

}
