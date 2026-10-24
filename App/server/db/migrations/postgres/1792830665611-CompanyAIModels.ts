import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyAIModels1792830665611 implements MigrationInterface {
    name = 'CompanyAIModels1792830665611'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_models" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "modelId" character varying NOT NULL, "isActive" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cb2ef91f252b1120c21bbce0fda" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7d3963b3045cf65c5168303871" ON "employee_models" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5998eb10ba3a91b1c3d9f40280" ON "employee_models" ("modelId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_442355432f293fc03cae530da9" ON "employee_models" ("employeeId", "modelId") `);
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "companyId" character varying`);
        await queryRunner.query(`ALTER TABLE "ai_models" ALTER COLUMN "employeeId" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`ALTER TABLE "ai_models" ALTER COLUMN "employeeId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "companyId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_442355432f293fc03cae530da9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5998eb10ba3a91b1c3d9f40280"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7d3963b3045cf65c5168303871"`);
        await queryRunner.query(`DROP TABLE "employee_models"`);
    }

}
