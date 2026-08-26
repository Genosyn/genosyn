import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineAssistant1787748241739 implements MigrationInterface {
    name = 'RoutineAssistant1787748241739'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_chat_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "routineId" character varying NOT NULL, "role" character varying NOT NULL, "employeeId" character varying, "modelId" character varying, "content" text NOT NULL DEFAULT '', "status" character varying, "actionsJson" text NOT NULL DEFAULT '', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c180da4d9bad5194dab42a9afbe" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f93ff07266d4f85bc8ccac7ebc" ON "routine_chat_messages" ("routineId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc82abc1e3889c33d51f6cf318" ON "routine_chat_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_fc82abc1e3889c33d51f6cf318"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f93ff07266d4f85bc8ccac7ebc"`);
        await queryRunner.query(`DROP TABLE "routine_chat_messages"`);
    }

}
