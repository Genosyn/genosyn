import { randomUUID } from "node:crypto";
import { MigrationInterface, QueryRunner } from "typeorm";

type Attachment = { employeeId: string; modelId: string; isActive: number };

/**
 * Turns every AI Model an AI Employee owned into a company AI Model attached
 * to that employee, between the sibling migrations that add
 * `ai_models.companyId` and `employee_models` (CompanyAIModels) and drop
 * `ai_models.employeeId` / `isActive` (DropEmployeeOwnedModelColumns).
 *
 * Each row keeps its id, so everything that names it carries on unchanged:
 * its credentials and backup keys (`configJson`, copied by nobody — the row
 * simply stays), their health (`ai_model_key_health`, keyed by the model id),
 * its context window and concurrent-Run setting, Routine pins, mailbox pins,
 * Work sessions and every message that records which model answered. The
 * ciphertext was always encrypted with the company's scope, so it decrypts
 * exactly as before. The employee's `isActive` flag moves onto the
 * attachment, with the model's creation time as the attachment's, so the
 * "most recently added" fallback picks the same model it did.
 *
 * Copies the old Reuse made stay separate company models: two rows with the
 * same key are only offered for merging, in Settings → AI Models, never merged
 * here. A model whose AI Employee no longer exists had no company to belong
 * to and nothing could reach it — deleting an employee or a company always
 * deleted its models — so it is deleted with its key health.
 *
 * Down gives every model back to one employee, the way the old schema needs:
 * the first employee it was attached to keeps the row, each further employee
 * gets its own copy (with the key health, and that employee's Routine,
 * mailbox and Work session pins moved onto it), and a model attached to no
 * one is deleted, since the old schema has nowhere to keep it.
 *
 * Hand-rolled because there's no schema diff for migration:generate to notice.
 */
export class BackfillCompanyAIModels1792830733839 implements MigrationInterface {
  name = "BackfillCompanyAIModels1792830733839";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const orphans = `SELECT "m"."id" FROM "ai_models" "m"
      LEFT JOIN "ai_employees" "e" ON "e"."id" = "m"."employeeId"
      WHERE "e"."id" IS NULL AND "m"."companyId" IS NULL`;
    await queryRunner.query(
      `DELETE FROM "ai_model_key_health" WHERE "modelId" IN (${orphans})`,
    );
    await queryRunner.query(`DELETE FROM "ai_models" WHERE "id" IN (${orphans})`);

    await queryRunner.query(
      `UPDATE "ai_models" SET "companyId" = (
         SELECT "e"."companyId" FROM "ai_employees" "e" WHERE "e"."id" = "ai_models"."employeeId"
       )
       WHERE "companyId" IS NULL`,
    );

    await queryRunner.query(
      `INSERT INTO "employee_models" ("id", "companyId", "employeeId", "modelId", "isActive", "createdAt")
       SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
              substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
              "m"."companyId", "m"."employeeId", "m"."id", "m"."isActive", "m"."createdAt"
       FROM "ai_models" "m"
       INNER JOIN "ai_employees" "e" ON "e"."id" = "m"."employeeId" AND "e"."companyId" = "m"."companyId"
       WHERE NOT EXISTS (
         SELECT 1 FROM "employee_models" "a"
         WHERE "a"."employeeId" = "m"."employeeId" AND "a"."modelId" = "m"."id"
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const attachments: Attachment[] = await queryRunner.query(
      `SELECT "a"."employeeId" AS "employeeId", "a"."modelId" AS "modelId", "a"."isActive" AS "isActive"
       FROM "employee_models" "a"
       INNER JOIN "ai_models" "m" ON "m"."id" = "a"."modelId"
       INNER JOIN "ai_employees" "e" ON "e"."id" = "a"."employeeId"
       ORDER BY "a"."modelId", "a"."createdAt", "a"."id"`,
    );
    const given = new Set<string>();
    for (const row of attachments) {
      const isActive = row.isActive ? 1 : 0;
      if (!given.has(row.modelId)) {
        given.add(row.modelId);
        await queryRunner.query(
          `UPDATE "ai_models" SET "employeeId" = ?, "isActive" = ? WHERE "id" = ?`,
          [row.employeeId, isActive, row.modelId],
        );
        continue;
      }
      const copyId = randomUUID();
      await queryRunner.query(
        `INSERT INTO "ai_models" ("id", "employeeId", "companyId", "provider", "model", "authMode", "configJson",
           "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns")
         SELECT ?, ?, "companyId", "provider", "model", "authMode", "configJson",
           "connectedAt", "createdAt", ?, "contextWindow", "contextWindowSource", "maxConcurrentRuns"
         FROM "ai_models" WHERE "id" = ?`,
        [copyId, row.employeeId, isActive, row.modelId],
      );
      const health: Array<{ keyId: string }> = await queryRunner.query(
        `SELECT "keyId" FROM "ai_model_key_health" WHERE "modelId" = ?`,
        [row.modelId],
      );
      for (const { keyId } of health) {
        await queryRunner.query(
          `INSERT INTO "ai_model_key_health" ("id", "modelId", "keyId", "lastUsedAt", "lastErrorAt",
             "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil", "createdAt")
           SELECT ?, ?, "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind",
             "lastErrorMessage", "coolDownUntil", "createdAt"
           FROM "ai_model_key_health" WHERE "modelId" = ? AND "keyId" = ?`,
          [randomUUID(), copyId, row.modelId, keyId],
        );
      }
      await queryRunner.query(
        `UPDATE "routines" SET "modelId" = ? WHERE "modelId" = ? AND "employeeId" = ?`,
        [copyId, row.modelId, row.employeeId],
      );
      await queryRunner.query(
        `UPDATE "mail_accounts" SET "aiAnalysisModelId" = ? WHERE "aiAnalysisModelId" = ? AND "aiAnalysisEmployeeId" = ?`,
        [copyId, row.modelId, row.employeeId],
      );
      await queryRunner.query(
        `UPDATE "repository_work_sessions" SET "modelId" = ? WHERE "modelId" = ? AND "employeeId" = ?`,
        [copyId, row.modelId, row.employeeId],
      );
    }

    const unattached = `SELECT "id" FROM "ai_models" WHERE "employeeId" IS NULL`;
    await queryRunner.query(`UPDATE "routines" SET "modelId" = NULL WHERE "modelId" IN (${unattached})`);
    await queryRunner.query(
      `UPDATE "mail_accounts" SET "aiAnalysisModelId" = NULL WHERE "aiAnalysisModelId" IN (${unattached})`,
    );
    await queryRunner.query(
      `DELETE FROM "ai_model_key_health" WHERE "modelId" IN (${unattached})`,
    );
    await queryRunner.query(`DELETE FROM "ai_models" WHERE "employeeId" IS NULL`);
    await queryRunner.query(`DELETE FROM "employee_models"`);
  }
}
