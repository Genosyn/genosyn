import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { toSlug } from "../lib/slug.js";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function seedFromUser(u: User): string {
  const fromName = toSlug(u.name || "");
  if (fromName && HANDLE_RE.test(fromName)) return fromName.slice(0, 32);
  const local = (u.email || "").split("@")[0] || "";
  const fromEmail = toSlug(local);
  if (fromEmail && HANDLE_RE.test(fromEmail)) return fromEmail.slice(0, 32);
  return "user";
}

/**
 * Pick a handle that doesn't collide with another user's handle or with an
 * AI employee slug in any company the user is a member of. The collision
 * check matches the rule enforced in `PATCH /auth/me`: a workspace `@token`
 * has to resolve unambiguously across humans and AI in the same room.
 */
async function pickAvailableHandle(user: User): Promise<string> {
  const userRepo = AppDataSource.getRepository(User);
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const memRepo = AppDataSource.getRepository(Membership);

  const memberships = await memRepo.findBy({ userId: user.id });
  const companyIds = memberships.map((m) => m.companyId);
  const reservedSlugs = new Set<string>();
  if (companyIds.length > 0) {
    const employees = await empRepo.findBy({ companyId: In(companyIds) });
    for (const e of employees) reservedSlugs.add(e.slug.toLowerCase());
  }

  const seed = seedFromUser(user);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? seed : `${seed}-${i + 1}`;
    if (candidate.length > 32) continue;
    if (reservedSlugs.has(candidate)) continue;
    const taken = await userRepo.findOneBy({ handle: candidate });
    if (taken && taken.id !== user.id) continue;
    return candidate;
  }
  // Last resort — guaranteed unique by id suffix.
  return `${seed.slice(0, 24)}-${user.id.slice(0, 6)}`;
}

/**
 * Make sure `user.handle` is set. Returns the (possibly newly assigned)
 * handle. Persists when a new value is generated. Safe to call repeatedly
 * — if the handle is already there we just hand it back.
 */
export async function ensureUserHandle(user: User): Promise<string> {
  if (user.handle) return user.handle;
  const next = await pickAvailableHandle(user);
  user.handle = next;
  await AppDataSource.getRepository(User).save(user);
  return next;
}

/**
 * Bulk variant for places that load a list of users at once (e.g. building
 * the workspace mentionables directory). Persists in one batch save and
 * returns the same array with handles populated, mutated in place.
 */
export async function ensureUserHandles(users: User[]): Promise<User[]> {
  const missing = users.filter((u) => !u.handle);
  if (missing.length === 0) return users;
  for (const u of missing) {
    u.handle = await pickAvailableHandle(u);
  }
  await AppDataSource.getRepository(User).save(missing);
  return users;
}
