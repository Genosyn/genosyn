import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Resource grants used `read | write`, mirroring notes. We've split write
 * into `edit` (modify only) + `delete` (modify + remove) so humans can
 * grant an AI employee curation authority without also handing it the
 * power to remove rows. The column type stays `varchar`; only the values
 * change. Existing `write` rows convert to `delete` because that's what
 * `write` actually let them do prior — turning every existing curator
 * into an `edit`-only would be a silent permission downgrade.
 *
 * Hand-rolled because there's no schema diff for migration:generate to
 * notice.
 */
export class ResourceAccessLevels1781300000000 implements MigrationInterface {
  name = "ResourceAccessLevels1781300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "employee_resource_grants" SET "accessLevel" = 'delete' WHERE "accessLevel" = 'write'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Collapse `edit` and `delete` back into the old `write` so a downgrade
    // doesn't strand rows with values the old code can't read.
    await queryRunner.query(
      `UPDATE "employee_resource_grants" SET "accessLevel" = 'write' WHERE "accessLevel" IN ('edit', 'delete')`,
    );
  }
}
