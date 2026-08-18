import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Repoints tag assignments from the old `code_repository` resource kind to
 * `repository`, following the Code → Repository rename.
 *
 * Hand-written on purpose, as the `RenameGmailProviderToGoogle` migration was:
 * this is a value inside a column, not a schema change, so there is nothing
 * for `migration:generate` to diff. Without it, every tag a company had put on
 * a repository would still be in the table but would match nothing, and the
 * tags would silently vanish from the page.
 *
 * The physical `code_repositories` table keeps its name — renaming a table is
 * a schema change, and the generated form of that is a drop and recreate.
 */
export class RenameCodeRepositoryTagTarget1787087700000 implements MigrationInterface {
  name = "RenameCodeRepositoryTagTarget1787087700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tag_assignments" SET "resourceType" = 'repository' WHERE "resourceType" = 'code_repository'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tag_assignments" SET "resourceType" = 'code_repository' WHERE "resourceType" = 'repository'`,
    );
  }
}
