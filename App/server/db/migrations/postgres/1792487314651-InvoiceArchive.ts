import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceArchive1792487314651 implements MigrationInterface {
    name = 'InvoiceArchive1792487314651'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_d250996aa223a63af6daf456a7" ON "invoices" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_745d074f0e40fbcc35e0858c68" ON "recurring_invoices" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_745d074f0e40fbcc35e0858c68"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d250996aa223a63af6daf456a7"`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" DROP COLUMN "archivedAt"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "archivedAt"`);
    }

}
