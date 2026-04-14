import fs from "node:fs";
import path from "node:path";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { routineDir, ensureDir } from "./paths.js";

export async function runRoutine(routine: Routine): Promise<Run> {
  const runRepo = AppDataSource.getRepository(Run);
  const routineRepo = AppDataSource.getRepository(Routine);
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const coRepo = AppDataSource.getRepository(Company);

  const emp = await empRepo.findOneBy({ id: routine.employeeId });
  if (!emp) throw new Error("Employee not found for routine");
  const co = await coRepo.findOneBy({ id: emp.companyId });
  if (!co) throw new Error("Company not found for employee");

  const now = new Date();
  const run = runRepo.create({
    routineId: routine.id,
    startedAt: now,
    status: "running",
  });
  const saved = await runRepo.save(run);

  const logsDir = path.join(routineDir(co.slug, emp.slug, routine.slug), "runs");
  ensureDir(logsDir);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logsDir, `${stamp}.log`);

  const lines = [
    `[${now.toISOString()}] run started`,
    `routine=${routine.name} (${routine.slug})`,
    `employee=${emp.name} (${emp.slug})`,
    `company=${co.name} (${co.slug})`,
    `model=${routine.modelId ?? emp.defaultModelId ?? "unassigned"}`,
    `cron=${routine.cronExpr}`,
    "",
    "[stub] runner is not yet wired to claude-code/codex/opencode.",
    "[stub] this is a placeholder log for M5 verification.",
  ];
  fs.writeFileSync(logFile, lines.join("\n") + "\n", "utf8");

  saved.finishedAt = new Date();
  saved.status = "completed";
  saved.logsPath = logFile;
  await runRepo.save(saved);

  routine.lastRunAt = saved.finishedAt;
  await routineRepo.save(routine);

  return saved;
}
