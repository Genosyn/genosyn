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
import { AuditEvent } from "./entities/AuditEvent.js";
import { Base } from "./entities/Base.js";
import { BaseTable } from "./entities/BaseTable.js";
import { BaseField } from "./entities/BaseField.js";
import { BaseRecord } from "./entities/BaseRecord.js";
import { BaseRecordComment } from "./entities/BaseRecordComment.js";
import { BaseRecordAttachment } from "./entities/BaseRecordAttachment.js";
import { BaseView } from "./entities/BaseView.js";
import { Backup } from "./entities/Backup.js";
import { BackupSchedule } from "./entities/BackupSchedule.js";
import { IntegrationConnection } from "./entities/IntegrationConnection.js";
import { EmployeeConnectionGrant } from "./entities/EmployeeConnectionGrant.js";
import { EmployeeBaseGrant } from "./entities/EmployeeBaseGrant.js";
import { EmployeeMemory } from "./entities/EmployeeMemory.js";
import { Channel } from "./entities/Channel.js";
import { ChannelMember } from "./entities/ChannelMember.js";
import { ChannelMessage } from "./entities/ChannelMessage.js";
import { MessageReaction } from "./entities/MessageReaction.js";
import { Attachment } from "./entities/Attachment.js";
import { Pipeline } from "./entities/Pipeline.js";
import { PipelineRun } from "./entities/PipelineRun.js";
import { EmailProvider } from "./entities/EmailProvider.js";
import { EmailLog } from "./entities/EmailLog.js";
import { Notebook } from "./entities/Notebook.js";
import { Note } from "./entities/Note.js";
import { EmployeeNoteGrant } from "./entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "./entities/EmployeeNotebookGrant.js";
import { Notification } from "./entities/Notification.js";
import { Team } from "./entities/Team.js";
import { Handoff } from "./entities/Handoff.js";
import { ApiKey } from "./entities/ApiKey.js";
import { Resource } from "./entities/Resource.js";
import { EmployeeResourceGrant } from "./entities/EmployeeResourceGrant.js";
import { Customer } from "./entities/Customer.js";
import { Product } from "./entities/Product.js";
import { TaxRate } from "./entities/TaxRate.js";
import { Invoice } from "./entities/Invoice.js";
import { InvoiceLineItem } from "./entities/InvoiceLineItem.js";
import { InvoicePayment } from "./entities/InvoicePayment.js";
import { Account } from "./entities/Account.js";
import { LedgerEntry } from "./entities/LedgerEntry.js";
import { LedgerLine } from "./entities/LedgerLine.js";
import { BankFeed } from "./entities/BankFeed.js";
import { BankTransaction } from "./entities/BankTransaction.js";
import { Currency } from "./entities/Currency.js";
import { ExchangeRate } from "./entities/ExchangeRate.js";
import { CompanyFinanceSettings } from "./entities/CompanyFinanceSettings.js";
import { AccountingPeriod } from "./entities/AccountingPeriod.js";
import { Vendor } from "./entities/Vendor.js";
import { Bill } from "./entities/Bill.js";
import { BillLineItem } from "./entities/BillLineItem.js";
import { BillPayment } from "./entities/BillPayment.js";

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
  AuditEvent,
  Base,
  BaseTable,
  BaseField,
  BaseRecord,
  BaseRecordComment,
  BaseRecordAttachment,
  BaseView,
  Backup,
  BackupSchedule,
  IntegrationConnection,
  EmployeeConnectionGrant,
  EmployeeBaseGrant,
  EmployeeMemory,
  Channel,
  ChannelMember,
  ChannelMessage,
  MessageReaction,
  Attachment,
  Pipeline,
  PipelineRun,
  EmailProvider,
  EmailLog,
  Notebook,
  Note,
  EmployeeNoteGrant,
  EmployeeNotebookGrant,
  Notification,
  Team,
  Handoff,
  ApiKey,
  Resource,
  EmployeeResourceGrant,
  Customer,
  Product,
  TaxRate,
  Invoice,
  InvoiceLineItem,
  InvoicePayment,
  Account,
  LedgerEntry,
  LedgerLine,
  BankFeed,
  BankTransaction,
  Currency,
  ExchangeRate,
  CompanyFinanceSettings,
  AccountingPeriod,
  Vendor,
  Bill,
  BillLineItem,
  BillPayment,
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
