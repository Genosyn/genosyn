import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionDiscussions1791458975362 implements MigrationInterface {
    name = 'DecisionDiscussions1791458975362'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar, "memberBrowserId" varchar, "discussedDecisionId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId" FROM "conversations"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversations" RENAME TO "conversations"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_11107f72f0e23051f012c69f3e" ON "conversations" ("discussedDecisionId", "ownerUserId") WHERE "discussedDecisionId" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_11107f72f0e23051f012c69f3e"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`ALTER TABLE "conversations" RENAME TO "temporary_conversations"`);
        await queryRunner.query(`CREATE TABLE "conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar, "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId" FROM "temporary_conversations"`);
        await queryRunner.query(`DROP TABLE "temporary_conversations"`);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
    }

}
