import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSDistributedAuth1784617758213 implements MigrationInterface {
    name = "SaaSDistributedAuth1784617758213";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "auth_flow_states" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tokenHash" character varying NOT NULL, "kind" character varying NOT NULL, "payloadEncrypted" text NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7b4395674430171b269e5431173" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_75143708da82049f088670ccd5" ON "auth_flow_states" ("expiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_68a4ba3026de3d0796752cd0aa" ON "auth_flow_states" ("tokenHash") `);
        await queryRunner.query(`CREATE TABLE "realtime_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "originId" character varying NOT NULL, "companyId" character varying NOT NULL, "eventJson" text NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_535dd20d151b19b78602eb4aebb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_22d5ad0cf7c809efd5e26517f1" ON "realtime_events" ("expiresAt") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "emailVerifiedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "users" ADD "emailVerificationTokenHash" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "emailVerificationExpiresAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "companies" ADD "requireTwoFactor" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "requireTwoFactor"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "emailVerificationExpiresAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "emailVerificationTokenHash"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "emailVerifiedAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_22d5ad0cf7c809efd5e26517f1"`);
        await queryRunner.query(`DROP TABLE "realtime_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_68a4ba3026de3d0796752cd0aa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75143708da82049f088670ccd5"`);
        await queryRunner.query(`DROP TABLE "auth_flow_states"`);
    }
}
