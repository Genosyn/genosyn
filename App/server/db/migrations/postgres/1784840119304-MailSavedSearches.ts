import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `MailSavedSearches1784840119303`
 * migration. The Postgres stream is a squashed initial snapshot plus tail
 * deltas (see server/db/migrations/postgres/) — a new table added after
 * PostgresInitial lands as its own delta here rather than editing the snapshot.
 *
 * Index names are byte-for-byte identical to the sqlite migration (TypeORM
 * derives them from a hash of table + columns, which is dialect-independent);
 * the PK constraint name comes from TypeORM's DefaultNamingStrategy, and
 * `float` normalises to `double precision` on this driver — both so a future
 * `migration:generate` on Postgres sees no drift.
 */
export class MailSavedSearches1784840119304 implements MigrationInterface {
  name = "MailSavedSearches1784840119304";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mail_saved_searches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "userId" character varying NOT NULL, "accountId" character varying NOT NULL, "name" character varying NOT NULL, "query" text NOT NULL, "sortOrder" double precision NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_26fbed467bba00e40944a50cff4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1ec8dff50f0fa4034d428f2dfa" ON "mail_saved_searches" ("companyId", "userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_67d2b408c487531fc1d030363b" ON "mail_saved_searches" ("userId", "accountId", "sortOrder") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_67d2b408c487531fc1d030363b"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1ec8dff50f0fa4034d428f2dfa"`);
    await queryRunner.query(`DROP TABLE "mail_saved_searches"`);
  }
}
