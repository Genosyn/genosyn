import "reflect-metadata";
import { DataSource } from "typeorm";
import path from "node:path";
import fs from "node:fs";
import { config } from "../../config.js";
import { User } from "./entities/User.js";
import { Company } from "./entities/Company.js";
import { Membership } from "./entities/Membership.js";
import { Invitation } from "./entities/Invitation.js";
import { AIModel } from "./entities/AIModel.js";
import { AIEmployee } from "./entities/AIEmployee.js";
import { Skill } from "./entities/Skill.js";
import { Routine } from "./entities/Routine.js";
import { Run } from "./entities/Run.js";

const entities = [User, Company, Membership, Invitation, AIModel, AIEmployee, Skill, Routine, Run];

function buildDataSource(): DataSource {
  if (config.db.driver === "postgres") {
    return new DataSource({
      type: "postgres",
      url: config.db.postgresUrl,
      entities,
      synchronize: true,
      logging: false,
    });
  }
  const sqlitePath = path.resolve(config.db.sqlitePath);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  return new DataSource({
    type: "better-sqlite3",
    database: sqlitePath,
    entities,
    synchronize: true,
    logging: false,
  });
}

export const AppDataSource = buildDataSource();

export async function initDb(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
}
