import { MigrationInterface, QueryRunner } from "typeorm";

export class UserSessions1788870253078 implements MigrationInterface {
    name = 'UserSessions1788870253078'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "user_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "sessionVersion" integer NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e93e031a5fed190d4789b6bfd83" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a5f2c875043dcf84df7b73ed73" ON "user_sessions" ("expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_55fa4db8406ed66bc704432842" ON "user_sessions" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_55fa4db8406ed66bc704432842"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5f2c875043dcf84df7b73ed73"`);
        await queryRunner.query(`DROP TABLE "user_sessions"`);
    }

}
