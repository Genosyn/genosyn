import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSHardeningIndexCompatibility1784536846394 implements MigrationInterface {
    name = "SaaSHardeningIndexCompatibility1784536846394";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`DROP INDEX "IDX_e501a0063af94fa35c1b32ddb0"`);
        await queryRunner.query(`DROP INDEX "IDX_1cd7060ff34ccf5a0592a31c30"`);
        await queryRunner.query(`DROP INDEX "IDX_716d53d2dcff9d76151e514028"`);
        await queryRunner.query(`DROP INDEX "IDX_9de6ae514ccb81f9f604080e57"`);
        await queryRunner.query(`DROP INDEX "IDX_0165ea2a104e3a1c468ef4a156"`);
        await queryRunner.query(`DROP INDEX "IDX_5c0b7eee1f860873f4c85e7248"`);
        await queryRunner.query(`DROP INDEX "IDX_bbc9efe961e93e01ad60841e68"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1696ad337de0bca45e52a78b22" ON "users" ("handle") WHERE "handle" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3bea38097742dc297e56154443" ON "project_members" ("projectId", "employeeId") WHERE "employeeId" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_105b84a5fe038043290ca18171" ON "project_members" ("projectId", "userId") WHERE "userId" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2d8807a303a16d39b67df2fa68" ON "channels" ("companyId", "slug") WHERE "slug" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d42fda591cc5214e996e1ffa57" ON "channel_members" ("channelId", "employeeId") WHERE "employeeId" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cb08ac313e245ef29b679b644f" ON "channel_members" ("channelId", "userId") WHERE "userId" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8a752dde84c4e6b7d07fc2bc01" ON "message_reactions" ("messageId", "emoji", "employeeId") WHERE "employeeId" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_01c7d0f19096d37de93afa3cc8" ON "message_reactions" ("messageId", "emoji", "userId") WHERE "userId" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_01c7d0f19096d37de93afa3cc8"`);
        await queryRunner.query(`DROP INDEX "IDX_8a752dde84c4e6b7d07fc2bc01"`);
        await queryRunner.query(`DROP INDEX "IDX_cb08ac313e245ef29b679b644f"`);
        await queryRunner.query(`DROP INDEX "IDX_d42fda591cc5214e996e1ffa57"`);
        await queryRunner.query(`DROP INDEX "IDX_2d8807a303a16d39b67df2fa68"`);
        await queryRunner.query(`DROP INDEX "IDX_105b84a5fe038043290ca18171"`);
        await queryRunner.query(`DROP INDEX "IDX_3bea38097742dc297e56154443"`);
        await queryRunner.query(`DROP INDEX "IDX_1696ad337de0bca45e52a78b22"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_bbc9efe961e93e01ad60841e68" ON "message_reactions" ("messageId", "emoji", "employeeId") WHERE employeeId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5c0b7eee1f860873f4c85e7248" ON "message_reactions" ("messageId", "emoji", "userId") WHERE userId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0165ea2a104e3a1c468ef4a156" ON "channel_members" ("channelId", "employeeId") WHERE employeeId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9de6ae514ccb81f9f604080e57" ON "channel_members" ("channelId", "userId") WHERE userId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_716d53d2dcff9d76151e514028" ON "channels" ("companyId", "slug") WHERE slug IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1cd7060ff34ccf5a0592a31c30" ON "project_members" ("projectId", "employeeId") WHERE employeeId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e501a0063af94fa35c1b32ddb0" ON "project_members" ("projectId", "userId") WHERE userId IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
    }
}
