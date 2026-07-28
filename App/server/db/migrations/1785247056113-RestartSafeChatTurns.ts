import { MigrationInterface, QueryRunner } from "typeorm";

export class RestartSafeChatTurns1785247056113 implements MigrationInterface {
    name = 'RestartSafeChatTurns1785247056113'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt" FROM "conversation_messages"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversation_messages" RENAME TO "conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`DROP INDEX "IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`CREATE TABLE "temporary_workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "employeeId" varchar, "ownerKey" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt", "employeeId") SELECT "id", "companyId", "kind", "expiresAt", "createdAt", "employeeId" FROM "workload_leases"`);
        await queryRunner.query(`DROP TABLE "workload_leases"`);
        await queryRunner.query(`ALTER TABLE "temporary_workload_leases" RENAME TO "workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_777e76e3d7ebbeec8617ea15ba" ON "workload_leases" ("ownerKey") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_777e76e3d7ebbeec8617ea15ba"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`DROP INDEX "IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" RENAME TO "temporary_workload_leases"`);
        await queryRunner.query(`CREATE TABLE "workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "employeeId" varchar)`);
        await queryRunner.query(`INSERT INTO "workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt", "employeeId") SELECT "id", "companyId", "kind", "expiresAt", "createdAt", "employeeId" FROM "temporary_workload_leases"`);
        await queryRunner.query(`DROP TABLE "temporary_workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" RENAME TO "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
    }

}
