import { MigrationInterface, QueryRunner } from "typeorm";

export class ResourceLibraryAccess1791273021438 implements MigrationInterface {
    name = 'ResourceLibraryAccess1791273021438'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_resource_library_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'write', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f51f4422712a8536f59a66481d3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b43126215f04005029274d829a" ON "employee_resource_library_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_dfe5e4d380ddb26bcffff76034" ON "employee_resource_library_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_dfe5e4d380ddb26bcffff76034"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b43126215f04005029274d829a"`);
        await queryRunner.query(`DROP TABLE "employee_resource_library_grants"`);
    }

}
