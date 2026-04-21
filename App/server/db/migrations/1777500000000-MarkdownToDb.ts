import { MigrationInterface, QueryRunner } from "typeorm";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../../config.js";

/**
 * Move Soul / Skill / Routine prose and Run logs off disk and into the DB.
 *
 * Previously `SOUL.md`, `skills/<slug>/README.md`, `routines/<slug>/README.md`
 * and `routines/<slug>/runs/*.log` were the source of truth; the DB only held
 * metadata. That made backup / restore awkward, broke Postgres self-hosts
 * (which don't get the filesystem side-by-side), and meant editing anything
 * required two persistence stores. The DB is now authoritative for all of it.
 *
 * Up:
 *   1. Add `soulBody`, `body`, `body`, `logContent` columns.
 *   2. Copy existing on-disk content into those columns (best-effort — a
 *      missing file is silently treated as empty).
 *   3. Delete the now-stale files / directories so the filesystem tree no
 *      longer advertises stale copies.
 *
 * Down drops the columns. The on-disk files are not recreated — the down
 * path is for re-running the migration in development, not rolling back a
 * production deploy.
 */
export class MarkdownToDb1777500000000 implements MigrationInterface {
  name = "MarkdownToDb1777500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_employees" ADD COLUMN "soulBody" text NOT NULL DEFAULT ('')`,
    );
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN "body" text NOT NULL DEFAULT ('')`,
    );
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "body" text NOT NULL DEFAULT ('')`,
    );
    await queryRunner.query(
      `ALTER TABLE "runs" ADD COLUMN "logContent" text NOT NULL DEFAULT ('')`,
    );

    const dataRoot = path.resolve(config.dataDir);

    type EmpRow = {
      id: string;
      slug: string;
      companyId: string;
      companySlug: string;
    };
    const emps: EmpRow[] = await queryRunner.query(
      `SELECT e.id as id, e.slug as slug, e.companyId as companyId, c.slug as companySlug
       FROM ai_employees e
       JOIN companies c ON c.id = e.companyId`,
    );

    const LOG_CAP = 256 * 1024;

    for (const e of emps) {
      const empDir = path.join(
        dataRoot,
        "companies",
        e.companySlug,
        "employees",
        e.slug,
      );

      // Soul
      const soulPath = path.join(empDir, "SOUL.md");
      const soulBody = readIfExists(soulPath);
      if (soulBody !== null) {
        await queryRunner.query(
          `UPDATE ai_employees SET soulBody = ? WHERE id = ?`,
          [soulBody, e.id],
        );
        safeUnlink(soulPath);
      }

      // Skills
      const skills: { id: string; slug: string }[] = await queryRunner.query(
        `SELECT id, slug FROM skills WHERE employeeId = ?`,
        [e.id],
      );
      for (const s of skills) {
        const readme = path.join(empDir, "skills", s.slug, "README.md");
        const body = readIfExists(readme);
        if (body !== null) {
          await queryRunner.query(
            `UPDATE skills SET body = ? WHERE id = ?`,
            [body, s.id],
          );
        }
      }
      safeRmDir(path.join(empDir, "skills"));

      // Routines + their run logs
      const routines: { id: string; slug: string }[] = await queryRunner.query(
        `SELECT id, slug FROM routines WHERE employeeId = ?`,
        [e.id],
      );
      for (const r of routines) {
        const routineDir = path.join(empDir, "routines", r.slug);
        const readme = path.join(routineDir, "README.md");
        const body = readIfExists(readme);
        if (body !== null) {
          await queryRunner.query(
            `UPDATE routines SET body = ? WHERE id = ?`,
            [body, r.id],
          );
        }

        // Pull each Run's log file into its row, capped.
        const runs: { id: string; logsPath: string | null }[] =
          await queryRunner.query(
            `SELECT id, logsPath FROM runs WHERE routineId = ?`,
            [r.id],
          );
        for (const run of runs) {
          if (!run.logsPath) continue;
          const log = readTail(run.logsPath, LOG_CAP);
          if (log === null) continue;
          await queryRunner.query(
            `UPDATE runs SET logContent = ? WHERE id = ?`,
            [log, run.id],
          );
        }
      }
      safeRmDir(path.join(empDir, "routines"));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "logContent"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "body"`);
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN "body"`);
    await queryRunner.query(`ALTER TABLE "ai_employees" DROP COLUMN "soulBody"`);
  }
}

function readIfExists(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the tail of a file (up to `cap` bytes). Matches the 256KB cap the
 * route used to apply on read so nothing human-visible changes in size.
 */
function readTail(file: string, cap: number): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (stat.size <= cap) return fs.readFileSync(file, "utf8");
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, stat.size - cap);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // best-effort
  }
}

function safeRmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
