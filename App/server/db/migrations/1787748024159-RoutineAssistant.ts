import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineAssistant1787748024159 implements MigrationInterface {
    name = 'RoutineAssistant1787748024159'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_chat_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "routineId" varchar NOT NULL, "role" varchar NOT NULL, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f93ff07266d4f85bc8ccac7ebc" ON "routine_chat_messages" ("routineId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc82abc1e3889c33d51f6cf318" ON "routine_chat_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_fc82abc1e3889c33d51f6cf318"`);
        await queryRunner.query(`DROP INDEX "IDX_f93ff07266d4f85bc8ccac7ebc"`);
        await queryRunner.query(`DROP TABLE "routine_chat_messages"`);
    }

}
