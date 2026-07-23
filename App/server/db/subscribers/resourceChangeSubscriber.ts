import type {
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
  RemoveEvent,
  SoftRemoveEvent,
  RecoverEvent,
  ObjectLiteral,
} from "typeorm";
import { AppDataSource } from "../datasource.js";
import { emitResourceChange, resourceEventsActive } from "../../services/resourceEvents.js";

/**
 * The one write choke-point behind app-wide live sync.
 *
 * TypeORM fans every insert / update / remove through here regardless of which
 * code path (HTTP route, MCP tool, cron, pipeline, mail sync) issued it. We map
 * the entity to a client `kind`, resolve its company, and hand a coarse
 * `resource.changed` event to {@link emitResourceChange}, which coalesces the
 * burst and broadcasts it. See `services/resourceEvents.ts` for the payload
 * contract — no row data ever leaves here.
 *
 * Registered manually (`AppDataSource.subscribers.push(...)` in `initDb`) rather
 * than via a decorator so there is exactly one instance and no glob-loading
 * surprises. It has no `listenTo()`, so TypeORM routes every entity to it; the
 * `REGISTRY` lookup is the real filter.
 */

/** A nested entity reaches its company through one FK hop to a parent. */
type ParentHop = { fk: string; parent: string };

type Mapping = {
  /** The client-facing resource family a page subscribes to. */
  kind: string;
  /** `"direct"` reads `entity.companyId`; a hop follows `entity[fk]` upward. */
  company: "direct" | ParentHop;
  /**
   * Optional field whose value scopes the event to one parent (a projectId, a
   * routineId, a tableId), so a single board refetches only for what it shows.
   * A wrong or absent field just degrades to a company-wide refetch — safe.
   */
  scopeFk?: string;
};

/**
 * Entity name → how it maps onto the live-sync surface. Anything NOT listed
 * here is skipped: infra rows (leases, tokens, sessions, push subscriptions,
 * and crucially the `RealtimeEvent` fan-out row itself — listing it would loop),
 * plus the surfaces that already own a realtime event (workspace chat,
 * notifications, the Mail mirror). Add an entry here + a `useLiveRefetch` on the
 * matching page and that page goes live.
 */
const REGISTRY: Record<string, Mapping> = {
  // ── AI substrate ─────────────────────────────────────────────────────────
  AIEmployee: { kind: "employee", company: "direct" },
  AIModel: { kind: "employee", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  Skill: { kind: "skill", company: { fk: "employeeId", parent: "AIEmployee" } },
  Routine: { kind: "routine", company: { fk: "employeeId", parent: "AIEmployee" } },
  Run: { kind: "run", company: { fk: "routineId", parent: "Routine" }, scopeFk: "routineId" },
  Handoff: { kind: "handoff", company: "direct" },
  JournalEntry: { kind: "journal", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeMemory: { kind: "memory", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  McpServer: { kind: "mcpserver", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },

  // ── Tasks (Projects + Todos) ─────────────────────────────────────────────
  Project: { kind: "project", company: "direct" },
  ProjectMember: { kind: "project", company: { fk: "projectId", parent: "Project" }, scopeFk: "projectId" },
  Todo: { kind: "todo", company: { fk: "projectId", parent: "Project" }, scopeFk: "projectId" },
  // No scopeFk on children: a comment's id granularity (todoId) differs from
  // what a board filters by (projectId), so it emits an empty scope that
  // matches every "todo" listener rather than a scope none of them would.
  TodoComment: { kind: "todo", company: { fk: "todoId", parent: "Todo" } },

  // ── Approvals & audit ────────────────────────────────────────────────────
  Approval: { kind: "approval", company: "direct" },
  AuditEvent: { kind: "audit", company: "direct" },

  // ── Bases ────────────────────────────────────────────────────────────────
  Base: { kind: "base", company: "direct" },
  BaseTable: { kind: "base", company: { fk: "baseId", parent: "Base" }, scopeFk: "baseId" },
  BaseField: { kind: "base", company: { fk: "tableId", parent: "BaseTable" }, scopeFk: "tableId" },
  BaseView: { kind: "base", company: { fk: "tableId", parent: "BaseTable" }, scopeFk: "tableId" },
  BaseRecord: { kind: "baserecord", company: { fk: "tableId", parent: "BaseTable" }, scopeFk: "tableId" },
  // Children emit an empty scope (see TodoComment) so a record drawer's
  // comment/attachment write still reaches a grid filtered by tableId.
  BaseRecordComment: { kind: "baserecord", company: { fk: "recordId", parent: "BaseRecord" } },
  BaseRecordAttachment: { kind: "baserecord", company: "direct" },

  // ── Notes ────────────────────────────────────────────────────────────────
  Notebook: { kind: "notebook", company: "direct" },
  Note: { kind: "note", company: "direct" },

  // ── Resources ────────────────────────────────────────────────────────────
  Resource: { kind: "resource", company: "direct" },

  // ── Explore (charts + dashboards) ────────────────────────────────────────
  Chart: { kind: "chart", company: "direct" },
  Dashboard: { kind: "dashboard", company: "direct" },
  DashboardCard: { kind: "dashboard", company: { fk: "dashboardId", parent: "Dashboard" }, scopeFk: "dashboardId" },

  // ── Code repositories ────────────────────────────────────────────────────
  CodeRepository: { kind: "coderepo", company: "direct" },

  // ── Pipelines ────────────────────────────────────────────────────────────
  Pipeline: { kind: "pipeline", company: "direct" },
  PipelineRun: { kind: "pipeline", company: { fk: "pipelineId", parent: "Pipeline" }, scopeFk: "pipelineId" },

  // ── Customers & contracts ────────────────────────────────────────────────
  Customer: { kind: "customer", company: "direct" },
  CustomerContact: { kind: "customer", company: "direct", scopeFk: "customerId" },
  CustomerContract: { kind: "contract", company: "direct" },

  // ── Finance ──────────────────────────────────────────────────────────────
  Product: { kind: "product", company: "direct" },
  TaxRate: { kind: "taxrate", company: "direct" },
  Invoice: { kind: "invoice", company: "direct" },
  InvoicePayment: { kind: "invoice", company: { fk: "invoiceId", parent: "Invoice" }, scopeFk: "invoiceId" },
  RecurringInvoice: { kind: "recurringinvoice", company: "direct" },
  Estimate: { kind: "estimate", company: "direct" },
  Vendor: { kind: "vendor", company: "direct" },
  Bill: { kind: "bill", company: "direct" },
  BillPayment: { kind: "bill", company: { fk: "billId", parent: "Bill" }, scopeFk: "billId" },
  Account: { kind: "financeaccount", company: "direct" },
  LedgerEntry: { kind: "ledger", company: "direct" },
  BankFeed: { kind: "reconcile", company: "direct" },
  BankTransaction: { kind: "reconcile", company: "direct" },
  CardFeed: { kind: "cardexpense", company: "direct" },
  CardTransaction: { kind: "cardexpense", company: "direct" },
  Currency: { kind: "currency", company: "direct" },
  ExchangeRate: { kind: "currency", company: "direct" },
  CompanyFinanceSettings: { kind: "financesettings", company: "direct" },
  AccountingPeriod: { kind: "period", company: "direct" },
  AdSpendEvent: { kind: "adspend", company: "direct" },

  // ── Integrations, settings, org ──────────────────────────────────────────
  IntegrationConnection: { kind: "connection", company: "direct" },
  Secret: { kind: "secret", company: "direct" },
  ApiKey: { kind: "apikey", company: "direct" },
  Tag: { kind: "tag", company: "direct" },
  Team: { kind: "team", company: "direct" },
  Membership: { kind: "member", company: "direct" },
  Invitation: { kind: "member", company: "direct" },
  EmailProvider: { kind: "emailprovider", company: "direct" },
  EmailLog: { kind: "emaillog", company: "direct" },

  // ── AI-access grants (the "AI access" panels) ────────────────────────────
  EmployeeFinanceGrant: { kind: "grant", company: "direct", scopeFk: "employeeId" },
  EmployeeConnectionGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeResourceGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeBaseGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeCodeRepositoryGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeNoteGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeNotebookGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeChartGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeDashboardGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
  EmployeeMailAccountGrant: { kind: "grant", company: { fk: "employeeId", parent: "AIEmployee" }, scopeFk: "employeeId" },
};

/**
 * `${entityName}:${id}` → companyId. The parent → company mapping is immutable
 * (a run's routine never changes company, a todo's project never moves tenant),
 * so a hit is permanent and this needs no invalidation — only a size cap.
 */
const companyCache = new Map<string, string>();
const COMPANY_CACHE_MAX = 5000;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Walk the parent chain to a company id, memoizing each immutable hop. */
async function resolveParentCompany(parentName: string, id: string): Promise<string | null> {
  const key = `${parentName}:${id}`;
  const cached = companyCache.get(key);
  if (cached) return cached;

  let row: ObjectLiteral | null;
  try {
    row = await AppDataSource.getRepository<ObjectLiteral>(parentName).findOne({ where: { id } });
  } catch {
    return null;
  }
  if (!row) return null;

  const reg = REGISTRY[parentName];
  let companyId: string | null;
  if (!reg || reg.company === "direct") {
    companyId = str(row.companyId) ?? null;
  } else {
    const nextId = str(row[reg.company.fk]);
    companyId = nextId ? await resolveParentCompany(reg.company.parent, nextId) : null;
  }

  if (companyId) {
    if (companyCache.size >= COMPANY_CACHE_MAX) companyCache.clear();
    companyCache.set(key, companyId);
  }
  return companyId;
}

export class ResourceChangeSubscriber implements EntitySubscriberInterface {
  afterInsert(event: InsertEvent<ObjectLiteral>): void {
    this.handle(event.metadata.name, event.entity);
  }

  afterUpdate(event: UpdateEvent<ObjectLiteral>): void {
    this.handle(event.metadata.name, event.entity ?? event.databaseEntity);
  }

  afterRemove(event: RemoveEvent<ObjectLiteral>): void {
    this.handle(event.metadata.name, event.databaseEntity ?? event.entity);
  }

  afterSoftRemove(event: SoftRemoveEvent<ObjectLiteral>): void {
    this.handle(event.metadata.name, event.entity ?? event.databaseEntity);
  }

  afterRecover(event: RecoverEvent<ObjectLiteral>): void {
    this.handle(event.metadata.name, event.entity ?? event.databaseEntity);
  }

  /**
   * Map one write onto the live-sync surface. Kept off the write's critical
   * path: direct-company entities emit synchronously (a map write); nested ones
   * resolve their company in the background so the originating save never waits
   * and a lookup failure can never throw back into TypeORM.
   */
  private handle(entityName: string, entity: ObjectLiteral | undefined): void {
    if (!resourceEventsActive()) return;
    const reg = REGISTRY[entityName];
    if (!reg || !entity) return;

    const scopeId = reg.scopeFk ? str(entity[reg.scopeFk]) : undefined;

    if (reg.company === "direct") {
      const companyId = str(entity.companyId);
      if (companyId) emitResourceChange(companyId, reg.kind, scopeId);
      return;
    }

    const parentId = str(entity[reg.company.fk]);
    if (!parentId) return;
    const parent = reg.company.parent;
    void resolveParentCompany(parent, parentId)
      .then((companyId) => {
        if (companyId) emitResourceChange(companyId, reg.kind, scopeId);
      })
      .catch(() => {
        // A missed fan-out is self-correcting: the next write or a manual
        // refresh reconciles. Never let it surface as a write failure.
      });
  }
}
