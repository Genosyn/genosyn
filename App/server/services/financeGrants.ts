import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  EmployeeFinanceGrant,
  FINANCE_ACCESS_RANK,
  type FinanceAccessLevel,
} from "../db/entities/EmployeeFinanceGrant.js";

/**
 * The finance grant is the AI-side gate for the whole Finance system
 * (invoices, customers, payments, the books). Humans authorize an employee
 * from **Finance → AI access**; the MCP finance tools then answer to the
 * level stored here. Members bypass it — this only governs the AI surface.
 *
 * One row per employee (finance is a single company-wide subsystem, not a set
 * of rows like mailboxes or resources), so the helpers key off `employeeId`.
 */

export type HydratedFinanceGrant = {
  id: string;
  employeeId: string;
  accessLevel: FinanceAccessLevel;
  createdAt: string;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  } | null;
};

export async function getFinanceGrant(
  employeeId: string,
): Promise<EmployeeFinanceGrant | null> {
  return AppDataSource.getRepository(EmployeeFinanceGrant).findOneBy({ employeeId });
}

/**
 * True when the employee holds a finance grant at or above `required`. The
 * whole gate is a single integer `>=` on the rank map — mirrors
 * `hasResourceAccess` / the mail rank check.
 */
export async function hasFinanceAccess(
  employeeId: string,
  required: FinanceAccessLevel,
): Promise<boolean> {
  const grant = await getFinanceGrant(employeeId);
  if (!grant) return false;
  return FINANCE_ACCESS_RANK[grant.accessLevel] >= FINANCE_ACCESS_RANK[required];
}

/** Create or move an employee's finance grant to `level`. Idempotent. */
export async function upsertFinanceGrant(
  companyId: string,
  employeeId: string,
  level: FinanceAccessLevel,
): Promise<EmployeeFinanceGrant> {
  const repo = AppDataSource.getRepository(EmployeeFinanceGrant);
  let grant = await repo.findOneBy({ employeeId });
  if (grant) {
    grant.accessLevel = level;
    // Keep the denormalized companyId honest even if an employee somehow
    // moved companies — it never should, but the write is cheap.
    grant.companyId = companyId;
  } else {
    grant = repo.create({ companyId, employeeId, accessLevel: level });
  }
  return repo.save(grant);
}

function hydrate(
  grants: EmployeeFinanceGrant[],
  employees: Map<string, AIEmployee>,
): HydratedFinanceGrant[] {
  return grants.map((g) => {
    const emp = employees.get(g.employeeId);
    return {
      id: g.id,
      employeeId: g.employeeId,
      accessLevel: g.accessLevel,
      createdAt: g.createdAt.toISOString(),
      employee: emp
        ? {
            id: emp.id,
            name: emp.name,
            slug: emp.slug,
            role: emp.role,
            avatarKey: emp.avatarKey,
          }
        : null,
    };
  });
}

/** Every finance grant in the company, employee-hydrated, oldest first. */
export async function listFinanceGrants(
  companyId: string,
): Promise<HydratedFinanceGrant[]> {
  const grants = await AppDataSource.getRepository(EmployeeFinanceGrant).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(grants.map((g) => g.employeeId)) },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return hydrate(grants, byId);
}

export type FinanceGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  alreadyGranted: boolean;
};

/** All company AI employees, each flagged whether it already has finance access. */
export async function listFinanceGrantCandidates(
  companyId: string,
): Promise<FinanceGrantCandidate[]> {
  const [employees, grants] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      order: { name: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeFinanceGrant).find({ where: { companyId } }),
  ]);
  const granted = new Set(grants.map((g) => g.employeeId));
  return employees.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    role: e.role,
    avatarKey: e.avatarKey,
    alreadyGranted: granted.has(e.id),
  }));
}

/** Revoke a grant by id, scoped to the company. Returns false if not found. */
export async function deleteFinanceGrant(
  companyId: string,
  id: string,
): Promise<EmployeeFinanceGrant | null> {
  const repo = AppDataSource.getRepository(EmployeeFinanceGrant);
  const grant = await repo.findOneBy({ id, companyId });
  if (!grant) return null;
  await repo.delete({ id: grant.id });
  return grant;
}

const FINANCE_LEVEL_BLURB: Record<FinanceAccessLevel, string> = {
  read: "You can read the books: list and open invoices and customers, and pull financial reports and posted transactions. You cannot change anything.",
  invoice:
    "You can run accounts receivable: create, issue, email, and void invoices; create and update customers; and record or reverse payments to mark invoices paid. You can also read everything at the `read` level. Issuing an invoice mints its number and posts it to the ledger; sending emails it to the customer on file — do those deliberately.",
  full: "You have full finance access: everything `invoice` allows, plus staging general-ledger category changes for a human to approve via `review_finance_transaction`. Final approval always stays with a human owner or admin — you never post a reclassification yourself.",
};

/**
 * A ready-made markdown section telling the employee it has finance access,
 * at what level, and what that permits. Injected into the chat / routine
 * prompt next to the Code Repositories context. Returns "" when the employee
 * has no finance grant, so nothing is injected for employees without access.
 */
export async function composeFinanceContext(employeeId: string): Promise<string> {
  const grant = await getFinanceGrant(employeeId);
  if (!grant) return "";
  return [
    "",
    "## Finance",
    `You have been granted **${grant.accessLevel}** access to the company's finance system. Work it through the \`finance\` tool (\`op\`: list_invoices / get_invoice / create_invoice / send_invoice / record_payment / void_invoice / list_customers / get_customer / create_customer / update_customer, plus the read-only accounts / transactions / report ops).`,
    FINANCE_LEVEL_BLURB[grant.accessLevel],
    "Money is stored in integer minor units (cents) with a 3-letter ISO currency code. When a teammate asks you to bill someone, create the invoice, then issue or send it — don't just describe it.",
  ].join("\n");
}
