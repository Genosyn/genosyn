import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelWaits1793398880775 implements MigrationInterface {
    name = 'ModelWaits1793398880775'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_waits" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "targetId" varchar NOT NULL, "groupKey" varchar, "employeeId" varchar NOT NULL, "modelId" varchar, "status" varchar NOT NULL DEFAULT ('waiting'), "attempts" integer NOT NULL DEFAULT (0), "resumeAt" datetime NOT NULL, "claimedUntil" datetime, "payloadJson" text NOT NULL DEFAULT ('{}'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1988c828d4fe0b5f5ba84245cb" ON "ai_model_waits" ("kind", "groupKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c226473e172c35871b5809169" ON "ai_model_waits" ("companyId", "modelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6d7e065055c29bdc48c7337ef1" ON "ai_model_waits" ("status", "resumeAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0bf43e576afc49d0b5d7fa0a78" ON "ai_model_waits" ("kind", "targetId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0bf43e576afc49d0b5d7fa0a78"`);
        await queryRunner.query(`DROP INDEX "IDX_6d7e065055c29bdc48c7337ef1"`);
        await queryRunner.query(`DROP INDEX "IDX_0c226473e172c35871b5809169"`);
        await queryRunner.query(`DROP INDEX "IDX_1988c828d4fe0b5f5ba84245cb"`);
        await queryRunner.query(`DROP TABLE "ai_model_waits"`);
    }

}
