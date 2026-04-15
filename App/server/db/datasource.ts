import "reflect-metadata";
import { DataSource } from "typeorm";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { Project } from "./entities/Project.js";
import { Todo } from "./entities/Todo.js";
import { TodoComment } from "./entities/TodoComment.js";
import { Conversation } from "./entities/Conversation.js";
import { ConversationMessage } from "./entities/ConversationMessage.js";
import { JournalEntry } from "./entities/JournalEntry.js";
import { Approval } from "./entities/Approval.js";
import { McpServer } from "./entities/McpServer.js";
import { Secret } from "./entities/Secret.js";

const entities = [
  User,
  Company,
  Membership,
  Invitation,
  AIModel,
  AIEmployee,
  Skill,
  Routine,
  Run,
  Project,
  Todo,
  TodoComment,
  Conversation,
  ConversationMessage,
  JournalEntry,
  Approval,
  McpServer,
  Secret,
];

// Migrations glob -- matches .ts files under server/db/migrations in dev (via tsx)
// and the compiled .js files under dist/server/db/migrations in production.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrations = [path.join(__dirname, "migrations", "*.{ts,js}")];

function buildDataSource(): DataSource {
  if (config.db.driver === "postgres") {
    return new DataSource({
      type: "postgres",
      url: config.db.postgresUrl,
      entities,
      migrations,
      synchronize: false,
      logging: false,
    });
  }
  const sqlitePath = path.resolve(config.db.sqlitePath);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  return new DataSource({
    type: "better-sqlite3",
    database: sqlitePath,
    entities,
    migrations,
    synchronize: false,
    logging: false,
  });
}

export const AppDataSource = buildDataSource();

export async function initDb(): Promise<void> {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
  // Run any pending migrations on boot. Idempotent -- already-run migrations
  // are tracked in the `migrations` table that TypeORM manages.
  await AppDataSource.runMigrations();
}
