import { MigrationInterface, QueryRunner } from "typeorm";

export class MemberBrowsers1786874110241 implements MigrationInterface {
    name = 'MemberBrowsers1786874110241'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "member_browsers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "ownerUserId" character varying NOT NULL, "name" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "pairingCodeHash" character varying(64), "pairingCodeExpiresAt" TIMESTAMP WITH TIME ZONE, "tokenHash" character varying(64), "tokenPrefix" character varying(16), "allowedHosts" text, "approvalRequired" boolean NOT NULL DEFAULT true, "allowUnattended" boolean NOT NULL DEFAULT false, "browserVersion" character varying, "platform" character varying, "lastSeenAt" TIMESTAMP WITH TIME ZONE, "revokedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3992e8028e6b4de99d72402935f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_38a9d8659c2dc2c30196875b5a" ON "member_browsers" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_866b9d867253051a653a5d4783" ON "member_browsers" ("ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0747743c60b5b20a1132f4d4c9" ON "member_browsers" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_675c36aaea578f71099549a57e" ON "member_browsers" ("companyId", "ownerUserId") `);
        await queryRunner.query(`CREATE TABLE "employee_member_browser_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "memberBrowserId" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6a6f7fe9b4a9d58f9e4f180d8db" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9620dde0901380e6c914864281" ON "employee_member_browser_grants" ("employeeId", "memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e3aac3d293b4dd58f811d2f85" ON "employee_member_browser_grants" ("memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b30f7588502ac0c65852e120e0" ON "employee_member_browser_grants" ("employeeId") `);
        await queryRunner.query(`ALTER TABLE "routines" ADD "memberBrowserId" character varying`);
        await queryRunner.query(`ALTER TABLE "conversations" ADD "memberBrowserId" character varying`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" ADD "memberBrowserId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_8e29c351af77efbe3e30d0b5ab" ON "browser_sessions" ("memberBrowserId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_8e29c351af77efbe3e30d0b5ab"`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" DROP COLUMN "memberBrowserId"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "memberBrowserId"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "memberBrowserId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b30f7588502ac0c65852e120e0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e3aac3d293b4dd58f811d2f85"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9620dde0901380e6c914864281"`);
        await queryRunner.query(`DROP TABLE "employee_member_browser_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_675c36aaea578f71099549a57e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0747743c60b5b20a1132f4d4c9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_866b9d867253051a653a5d4783"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_38a9d8659c2dc2c30196875b5a"`);
        await queryRunner.query(`DROP TABLE "member_browsers"`);
    }

}
