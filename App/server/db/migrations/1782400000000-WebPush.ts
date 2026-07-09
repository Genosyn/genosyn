import { MigrationInterface, QueryRunner } from "typeorm";

export class WebPush1782400000000 implements MigrationInterface {
    name = 'WebPush1782400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "app_settings" ("key" varchar PRIMARY KEY NOT NULL, "value" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE "push_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "endpoint" varchar(1024) NOT NULL, "p256dh" varchar NOT NULL, "auth" varchar NOT NULL, "userAgent" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0008bdfd174e533a3f98bf9af1" ON "push_subscriptions" ("endpoint") `);
        await queryRunner.query(`CREATE INDEX "IDX_4cc061875e9eecc311a94b3e43" ON "push_subscriptions" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_4cc061875e9eecc311a94b3e43"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_0008bdfd174e533a3f98bf9af1"`);
        await queryRunner.query(`DROP TABLE "push_subscriptions"`);
        await queryRunner.query(`DROP TABLE "app_settings"`);
    }

}
