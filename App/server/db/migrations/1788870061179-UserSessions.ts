import { MigrationInterface, QueryRunner } from "typeorm";

export class UserSessions1788870061179 implements MigrationInterface {
    name = 'UserSessions1788870061179'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "user_sessions" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "sessionVersion" integer NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a5f2c875043dcf84df7b73ed73" ON "user_sessions" ("expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_55fa4db8406ed66bc704432842" ON "user_sessions" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_55fa4db8406ed66bc704432842"`);
        await queryRunner.query(`DROP INDEX "IDX_a5f2c875043dcf84df7b73ed73"`);
        await queryRunner.query(`DROP TABLE "user_sessions"`);
    }

}
