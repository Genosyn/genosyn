import { MigrationInterface, QueryRunner } from "typeorm";

export class MembershipFinanceAccess1784895245535 implements MigrationInterface {
    name = 'MembershipFinanceAccess1784895245535'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860"`);
        await queryRunner.query(`CREATE TABLE "temporary_memberships" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "userId" varchar NOT NULL, "role" varchar NOT NULL, "financeAccess" varchar NOT NULL DEFAULT ('full'))`);
        await queryRunner.query(`INSERT INTO "temporary_memberships"("id", "companyId", "userId", "role") SELECT "id", "companyId", "userId", "role" FROM "memberships"`);
        await queryRunner.query(`DROP TABLE "memberships"`);
        await queryRunner.query(`ALTER TABLE "temporary_memberships" RENAME TO "memberships"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860" ON "memberships" ("companyId", "userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860"`);
        await queryRunner.query(`ALTER TABLE "memberships" RENAME TO "temporary_memberships"`);
        await queryRunner.query(`CREATE TABLE "memberships" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "userId" varchar NOT NULL, "role" varchar NOT NULL)`);
        await queryRunner.query(`INSERT INTO "memberships"("id", "companyId", "userId", "role") SELECT "id", "companyId", "userId", "role" FROM "temporary_memberships"`);
        await queryRunner.query(`DROP TABLE "temporary_memberships"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860" ON "memberships" ("companyId", "userId") `);
    }

}
