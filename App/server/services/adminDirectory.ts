import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";

/**
 * Admin directory — the read side of the instance-wide Users and Companies
 * management surfaces under Admin. Where `instanceHealth.ts` reports on the
 * deployment substrate, this enumerates the tenants and people on it so an
 * operator can see, and prune, the whole install from one place.
 *
 * Not company-scoped. See `routes/admin.ts` for the trust model that governs
 * who may read (and delete) these rows.
 *
 * Aggregation runs in memory from a handful of full-table reads rather than
 * per-row correlated queries: at self-host scale (dozens of companies, low
 * hundreds of users) this is a couple of cheap scans, and it keeps the joins
 * readable without a raw SQL builder. Employee counts use a single grouped
 * TypeORM query since that table is the one that can grow.
 */

/** A company this user is the registered owner of (`companies.ownerId`). */
export type OwnedCompanyRef = { id: string; name: string; slug: string };

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarKey: string | null;
  createdAt: string;
  /** Instance-level operator flag — gates the Admin dashboard. */
  isMasterAdmin: boolean;
  /** How many companies this user is a member of (any role). */
  membershipCount: number;
  /** Companies where this user is the owner — blocks deletion until reassigned. */
  ownedCompanies: OwnedCompanyRef[];
};

export type AdminCompanyRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  /** The registered owner, or null if the owner row has gone missing. */
  owner: { id: string; name: string; email: string } | null;
  /** Human members (memberships), including the owner. */
  memberCount: number;
  /** AI employees registered under this company. */
  employeeCount: number;
};

/** Group `AIEmployee` counts by company in one query — the only table that
 *  can realistically grow, so it earns a `GROUP BY` instead of a full scan. */
async function employeeCountsByCompany(): Promise<Map<string, number>> {
  const rows = await AppDataSource.getRepository(AIEmployee)
    .createQueryBuilder("e")
    .select("e.companyId", "companyId")
    .addSelect("COUNT(*)", "count")
    .groupBy("e.companyId")
    .getRawMany<{ companyId: string; count: string | number }>();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.companyId, Number(r.count));
  return map;
}

/** Every human user on the install, oldest first, with membership + ownership
 *  rollups so the Admin → Users page can render without N per-row requests. */
export async function listAdminUsers(): Promise<AdminUserRow[]> {
  const [users, memberships, companies] = await Promise.all([
    AppDataSource.getRepository(User).find({ order: { createdAt: "ASC" } }),
    AppDataSource.getRepository(Membership).find(),
    AppDataSource.getRepository(Company).find({
      select: ["id", "name", "slug", "ownerId"],
    }),
  ]);

  const membershipCount = new Map<string, number>();
  for (const m of memberships) {
    membershipCount.set(m.userId, (membershipCount.get(m.userId) ?? 0) + 1);
  }

  const ownedByUser = new Map<string, OwnedCompanyRef[]>();
  for (const c of companies) {
    const list = ownedByUser.get(c.ownerId);
    const ref: OwnedCompanyRef = { id: c.id, name: c.name, slug: c.slug };
    if (list) list.push(ref);
    else ownedByUser.set(c.ownerId, [ref]);
  }

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle,
    avatarKey: u.avatarKey,
    createdAt: u.createdAt.toISOString(),
    isMasterAdmin: u.isMasterAdmin,
    membershipCount: membershipCount.get(u.id) ?? 0,
    ownedCompanies: ownedByUser.get(u.id) ?? [],
  }));
}

/** Every company on the install, oldest first, with owner + member + employee
 *  rollups so the Admin → Companies page can render in one request. */
export async function listAdminCompanies(): Promise<AdminCompanyRow[]> {
  const [companies, memberships, users, employeeCounts] = await Promise.all([
    AppDataSource.getRepository(Company).find({ order: { createdAt: "ASC" } }),
    AppDataSource.getRepository(Membership).find(),
    AppDataSource.getRepository(User).find({ select: ["id", "name", "email"] }),
    employeeCountsByCompany(),
  ]);

  const memberCount = new Map<string, number>();
  for (const m of memberships) {
    memberCount.set(m.companyId, (memberCount.get(m.companyId) ?? 0) + 1);
  }
  const userById = new Map(users.map((u) => [u.id, u]));

  return companies.map((c) => {
    const owner = userById.get(c.ownerId) ?? null;
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt.toISOString(),
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
      memberCount: memberCount.get(c.id) ?? 0,
      employeeCount: employeeCounts.get(c.id) ?? 0,
    };
  });
}
