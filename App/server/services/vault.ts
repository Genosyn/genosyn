import crypto from "node:crypto";
import { In } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  EMPLOYEE_VAULT_ACCESS_RANK,
  EmployeeVaultGrant,
  type EmployeeVaultAccessLevel,
} from "../db/entities/EmployeeVaultGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import {
  VaultItem,
  type VaultItemType,
  type VaultItemVisibility,
} from "../db/entities/VaultItem.js";
import {
  VaultItemMemberAccess,
  type VaultMemberAccessLevel,
} from "../db/entities/VaultItemMemberAccess.js";
import { decryptSecretWithStrongKeys, encryptSecret } from "../lib/secret.js";

const vaultPayloadSchema = z
  .object({
    title: z.string(),
    username: z.string(),
    secret: z.string(),
    websiteUrl: z.string(),
    notes: z.string(),
  })
  .strict();

export type VaultPayload = z.infer<typeof vaultPayloadSchema>;

const VAULT_PASSWORD_CHARACTER_CLASSES = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!@#$%^&*()-_=+[]{}:,.?",
] as const;
const VAULT_PASSWORD_ALPHABET = VAULT_PASSWORD_CHARACTER_CLASSES.join("");
const DEFAULT_VAULT_PASSWORD_LENGTH = 24;

export type VaultHumanActor = {
  userId: string;
  role: Role;
};

export type VaultItemView = {
  id: string;
  companyId: string;
  type: VaultItemType;
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  notes: string;
  version: number;
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdAt: Date;
  updatedAt: Date;
  effectiveAccessLevel: VaultMemberAccessLevel;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canReveal: boolean;
};

export type VaultMemberAccessView = {
  id: string;
  vaultItemId: string;
  userId: string;
  accessLevel: VaultMemberAccessLevel;
  createdAt: Date;
  updatedAt: Date;
  member: {
    id: string;
    name: string;
    email: string;
    role: Role;
  };
};

export type VaultMemberAccessCandidate = {
  id: string;
  name: string;
  email: string;
  role: Role;
  isCreator: boolean;
  access: {
    id: string;
    accessLevel: VaultMemberAccessLevel;
  } | null;
};

export type EmployeeVaultGrantView = {
  id: string;
  vaultItemId: string;
  employeeId: string;
  accessLevel: EmployeeVaultAccessLevel;
  createdAt: Date;
  updatedAt: Date;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
};

export type EmployeeVaultGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  grant: {
    id: string;
    accessLevel: EmployeeVaultAccessLevel;
  } | null;
};

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Generate a cryptographically random password with every standard character
 * class represented. The length bounds keep generated credentials compatible
 * with ordinary password fields while still providing ample entropy.
 */
export function generateVaultPassword(length = DEFAULT_VAULT_PASSWORD_LENGTH): string {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new VaultError("Password length must be an integer from 16 to 128", 400);
  }

  const characters = VAULT_PASSWORD_CHARACTER_CLASSES.map(
    (characterClass) => characterClass[crypto.randomInt(characterClass.length)],
  );
  while (characters.length < length) {
    characters.push(VAULT_PASSWORD_ALPHABET[crypto.randomInt(VAULT_PASSWORD_ALPHABET.length)]);
  }
  // Fisher-Yates with crypto.randomInt avoids modulo bias and prevents the
  // guaranteed character-class positions from being predictable.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

function encryptionScope(companyId: string): string {
  return `company:${companyId}:vault`;
}

function normalizeVaultWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const website = new URL(trimmed);
    if (website.protocol !== "http:" && website.protocol !== "https:") throw new Error();
    if (website.username || website.password) throw new Error();
    return website.toString();
  } catch {
    throw new VaultError(
      "Website URL must be an absolute http(s) URL without embedded credentials",
      400,
    );
  }
}

function decryptPayload(row: VaultItem): VaultPayload {
  try {
    const ciphertextParts = row.encryptedPayload.split(".");
    const storedScope =
      ciphertextParts.length === 5 && ciphertextParts[0] === "v2"
        ? Buffer.from(ciphertextParts[1], "base64url").toString("utf8")
        : "";
    if (storedScope !== encryptionScope(row.companyId)) {
      throw new Error("ciphertext scope does not match item company");
    }
    const decoded = JSON.parse(decryptSecretWithStrongKeys(row.encryptedPayload)) as unknown;
    const parsed = vaultPayloadSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid payload shape");
    return parsed.data;
  } catch {
    throw new VaultError("This Vault item could not be decrypted", 500);
  }
}

function encryptPayload(companyId: string, payload: VaultPayload): string {
  return encryptSecret(JSON.stringify(payload), encryptionScope(companyId));
}

function isHumanManager(row: VaultItem, actor: VaultHumanActor): boolean {
  return actor.role === "owner" || actor.role === "admin" || row.createdByUserId === actor.userId;
}

function effectiveHumanAccess(
  row: VaultItem,
  actor: VaultHumanActor,
  explicitAccess: VaultMemberAccessLevel | null,
): VaultMemberAccessLevel | null {
  if (isHumanManager(row, actor)) return "edit";
  if (explicitAccess === "edit") return "edit";
  if (row.visibility === "company" || explicitAccess === "view") return "view";
  return null;
}

function toView(
  row: VaultItem,
  payload: VaultPayload,
  actor: VaultHumanActor,
  explicitAccess: VaultMemberAccessLevel | null,
): VaultItemView {
  const effectiveAccessLevel = effectiveHumanAccess(row, actor, explicitAccess);
  if (!effectiveAccessLevel) throw new VaultError("Vault item not found", 404);
  const manager = isHumanManager(row, actor);
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type,
    visibility: row.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    notes: payload.notes,
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdByEmployeeId: row.createdByEmployeeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    effectiveAccessLevel,
    canEdit: effectiveAccessLevel === "edit",
    canShare: manager,
    canDelete: manager,
    canReveal: true,
  };
}

async function loadHumanAccess(
  companyId: string,
  itemId: string,
  userId: string,
): Promise<VaultItemMemberAccess | null> {
  return AppDataSource.getRepository(VaultItemMemberAccess).findOneBy({
    companyId,
    vaultItemId: itemId,
    userId,
  });
}

async function loadItem(companyId: string, itemId: string): Promise<VaultItem> {
  const row = await AppDataSource.getRepository(VaultItem).findOneBy({
    id: itemId,
    companyId,
  });
  if (!row) throw new VaultError("Vault item not found", 404);
  return row;
}

async function loadAccessibleItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<{
  row: VaultItem;
  payload: VaultPayload;
  explicitAccess: VaultMemberAccessLevel | null;
  view: VaultItemView;
}> {
  const row = await loadItem(companyId, itemId);
  const access = await loadHumanAccess(companyId, itemId, actor.userId);
  const explicitAccess = access?.accessLevel ?? null;
  if (!effectiveHumanAccess(row, actor, explicitAccess)) {
    throw new VaultError("Vault item not found", 404);
  }
  const payload = decryptPayload(row);
  return { row, payload, explicitAccess, view: toView(row, payload, actor, explicitAccess) };
}

async function loadManagedItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<{ row: VaultItem; payload: VaultPayload }> {
  const row = await loadItem(companyId, itemId);
  if (!isHumanManager(row, actor)) {
    throw new VaultError("Only the creator or a company admin can manage sharing", 403);
  }
  return { row, payload: decryptPayload(row) };
}

export async function listVaultItems(
  companyId: string,
  actor: VaultHumanActor,
): Promise<VaultItemView[]> {
  const rows = await AppDataSource.getRepository(VaultItem).find({
    where: { companyId },
    order: { updatedAt: "DESC", createdAt: "DESC" },
  });
  if (rows.length === 0) return [];

  const accessRows = await AppDataSource.getRepository(VaultItemMemberAccess).find({
    where: {
      companyId,
      userId: actor.userId,
      vaultItemId: In(rows.map((row) => row.id)),
    },
  });
  const accessByItem = new Map(accessRows.map((row) => [row.vaultItemId, row.accessLevel]));
  const visible = rows.filter(
    (row) => effectiveHumanAccess(row, actor, accessByItem.get(row.id) ?? null) !== null,
  );
  return visible.map((row) =>
    toView(row, decryptPayload(row), actor, accessByItem.get(row.id) ?? null),
  );
}

export async function getVaultItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<VaultItemView> {
  return (await loadAccessibleItem(companyId, itemId, actor)).view;
}

export async function createVaultItem(args: {
  companyId: string;
  actor: VaultHumanActor;
  type: VaultItemType;
  visibility: VaultItemVisibility;
  payload: VaultPayload;
}): Promise<VaultItemView> {
  const repo = AppDataSource.getRepository(VaultItem);
  const payload = {
    ...args.payload,
    websiteUrl: normalizeVaultWebsiteUrl(args.payload.websiteUrl),
  };
  const row = repo.create({
    companyId: args.companyId,
    type: args.type,
    visibility: args.visibility,
    encryptedPayload: encryptPayload(args.companyId, payload),
    createdByUserId: args.actor.userId,
    createdByEmployeeId: null,
  });
  await repo.save(row);
  return toView(row, payload, args.actor, null);
}

export async function updateVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  expectedVersion: number;
  patch: Partial<VaultPayload> & {
    type?: VaultItemType;
    visibility?: VaultItemVisibility;
  };
}): Promise<{ before: VaultItemView; item: VaultItemView }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (!loaded.view.canEdit) throw new VaultError("Edit access is required", 403);
  if (loaded.row.version !== args.expectedVersion) {
    throw new VaultError(
      "This Vault item changed while you were editing it. Reload and retry.",
      409,
    );
  }
  if (args.patch.visibility !== undefined && !isHumanManager(loaded.row, args.actor)) {
    throw new VaultError("Only the creator or a company admin can change visibility", 403);
  }

  const before = loaded.view;
  const payload: VaultPayload = {
    title: args.patch.title ?? loaded.payload.title,
    username: args.patch.username ?? loaded.payload.username,
    secret: args.patch.secret ?? loaded.payload.secret,
    websiteUrl:
      args.patch.websiteUrl === undefined
        ? loaded.payload.websiteUrl
        : normalizeVaultWebsiteUrl(args.patch.websiteUrl),
    notes: args.patch.notes ?? loaded.payload.notes,
  };
  const repo = AppDataSource.getRepository(VaultItem);
  const update = await repo.update(
    {
      id: loaded.row.id,
      companyId: args.companyId,
      version: args.expectedVersion,
    },
    {
      type: args.patch.type ?? loaded.row.type,
      visibility: args.patch.visibility ?? loaded.row.visibility,
      encryptedPayload: encryptPayload(args.companyId, payload),
      version: args.expectedVersion + 1,
    },
  );
  if (update.affected !== 1) {
    throw new VaultError(
      "This Vault item changed while you were editing it. Reload and retry.",
      409,
    );
  }
  const saved = await loadItem(args.companyId, args.itemId);
  return {
    before,
    item: toView(saved, payload, args.actor, loaded.explicitAccess),
  };
}

export async function deleteVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; title: string; type: VaultItemType }> {
  const { row, payload } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(VaultItemMemberAccess, {
      companyId: args.companyId,
      vaultItemId: row.id,
    });
    await manager.delete(EmployeeVaultGrant, {
      companyId: args.companyId,
      vaultItemId: row.id,
    });
    await manager.delete(VaultItem, { id: row.id, companyId: args.companyId });
  });
  return { id: row.id, title: payload.title, type: row.type };
}

export async function revealVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<{ item: VaultItemView; secret: string }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  return { item: loaded.view, secret: loaded.payload.secret };
}

export async function listVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<VaultMemberAccessView[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const rows = await AppDataSource.getRepository(VaultItemMemberAccess).find({
    where: { companyId: args.companyId, vaultItemId: args.itemId },
    order: { createdAt: "ASC" },
  });
  if (rows.length === 0) return [];
  const userIds = rows.map((row) => row.userId);
  const [users, memberships] = await Promise.all([
    AppDataSource.getRepository(User).find({ where: { id: In(userIds) } }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId: args.companyId, userId: In(userIds) },
    }),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const membershipsByUser = new Map(memberships.map((row) => [row.userId, row]));
  return rows.flatMap((row) => {
    const user = usersById.get(row.userId);
    const membership = membershipsByUser.get(row.userId);
    if (!user || !membership) return [];
    return [
      {
        id: row.id,
        vaultItemId: row.vaultItemId,
        userId: row.userId,
        accessLevel: row.accessLevel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        member: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: membership.role,
        },
      },
    ];
  });
}

export async function listVaultMemberAccessCandidates(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<VaultMemberAccessCandidate[]> {
  const { row } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId: args.companyId },
  });
  if (memberships.length === 0) return [];
  const [users, accessRows] = await Promise.all([
    AppDataSource.getRepository(User).find({
      where: { id: In(memberships.map((membership) => membership.userId)) },
    }),
    AppDataSource.getRepository(VaultItemMemberAccess).find({
      where: { companyId: args.companyId, vaultItemId: args.itemId },
    }),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const accessByUser = new Map(accessRows.map((access) => [access.userId, access]));
  return memberships
    .flatMap((membership) => {
      const user = usersById.get(membership.userId);
      if (!user) return [];
      const access = accessByUser.get(user.id);
      return [
        {
          id: user.id,
          name: user.name,
          email: user.email,
          role: membership.role,
          isCreator: row.createdByUserId === user.id,
          access: access ? { id: access.id, accessLevel: access.accessLevel } : null,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function assertCompanyMember(companyId: string, userId: string): Promise<void> {
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId,
  });
  if (!membership) throw new VaultError("Member not found", 404);
}

export async function upsertVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  userId: string;
  accessLevel: VaultMemberAccessLevel;
}): Promise<VaultMemberAccessView> {
  const { row } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  await assertCompanyMember(args.companyId, args.userId);
  if (row.createdByUserId === args.userId) {
    throw new VaultError("The creator already has full access", 400);
  }
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  let access = await repo.findOneBy({
    companyId: args.companyId,
    vaultItemId: args.itemId,
    userId: args.userId,
  });
  if (access) {
    access.accessLevel = args.accessLevel;
  } else {
    access = repo.create({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      userId: args.userId,
      accessLevel: args.accessLevel,
    });
  }
  await repo.save(access);
  const rows = await listVaultMemberAccess(args);
  const hydrated = rows.find((candidate) => candidate.id === access!.id);
  if (!hydrated) throw new VaultError("Member not found", 404);
  return hydrated;
}

export async function updateVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  accessId: string;
  actor: VaultHumanActor;
  accessLevel: VaultMemberAccessLevel;
}): Promise<VaultMemberAccessView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  const row = await repo.findOneBy({
    id: args.accessId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!row) throw new VaultError("Member access not found", 404);
  row.accessLevel = args.accessLevel;
  await repo.save(row);
  const rows = await listVaultMemberAccess(args);
  const hydrated = rows.find((candidate) => candidate.id === row.id);
  if (!hydrated) throw new VaultError("Member not found", 404);
  return hydrated;
}

export async function deleteVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  accessId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; userId: string; accessLevel: VaultMemberAccessLevel }> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  const row = await repo.findOneBy({
    id: args.accessId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!row) throw new VaultError("Member access not found", 404);
  await repo.delete({ id: row.id });
  return { id: row.id, userId: row.userId, accessLevel: row.accessLevel };
}

async function hydrateEmployeeGrants(
  rows: EmployeeVaultGrant[],
): Promise<EmployeeVaultGrantView[]> {
  if (rows.length === 0) return [];
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(rows.map((row) => row.employeeId)) },
  });
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return rows.flatMap((row) => {
    const employee = byId.get(row.employeeId);
    if (!employee || employee.companyId !== row.companyId) return [];
    return [
      {
        id: row.id,
        vaultItemId: row.vaultItemId,
        employeeId: row.employeeId,
        accessLevel: row.accessLevel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        employee: {
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          role: employee.role,
        },
      },
    ];
  });
}

export async function listEmployeeVaultGrants(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<EmployeeVaultGrantView[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const rows = await AppDataSource.getRepository(EmployeeVaultGrant).find({
    where: { companyId: args.companyId, vaultItemId: args.itemId },
    order: { createdAt: "ASC" },
  });
  return hydrateEmployeeGrants(rows);
}

export async function listEmployeeVaultGrantCandidates(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<EmployeeVaultGrantCandidate[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const [employees, grants] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: args.companyId },
      order: { name: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeVaultGrant).find({
      where: { companyId: args.companyId, vaultItemId: args.itemId },
    }),
  ]);
  const byEmployee = new Map(grants.map((grant) => [grant.employeeId, grant]));
  return employees.map((employee) => {
    const grant = byEmployee.get(employee.id);
    return {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      grant: grant ? { id: grant.id, accessLevel: grant.accessLevel } : null,
    };
  });
}

async function assertCompanyEmployee(companyId: string, employeeId: string): Promise<void> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new VaultError("AI Employee not found", 404);
}

export async function upsertEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  employeeId: string;
  accessLevel: EmployeeVaultAccessLevel;
}): Promise<EmployeeVaultGrantView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  let grant = await repo.findOneBy({
    companyId: args.companyId,
    vaultItemId: args.itemId,
    employeeId: args.employeeId,
  });
  if (grant) {
    grant.accessLevel = args.accessLevel;
  } else {
    grant = repo.create({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      employeeId: args.employeeId,
      accessLevel: args.accessLevel,
    });
  }
  await repo.save(grant);
  const [hydrated] = await hydrateEmployeeGrants([grant]);
  if (!hydrated) throw new VaultError("AI Employee not found", 404);
  return hydrated;
}

export async function updateEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  grantId: string;
  actor: VaultHumanActor;
  accessLevel: EmployeeVaultAccessLevel;
}): Promise<EmployeeVaultGrantView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  const grant = await repo.findOneBy({
    id: args.grantId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!grant) throw new VaultError("Vault Grant not found", 404);
  grant.accessLevel = args.accessLevel;
  await repo.save(grant);
  const [hydrated] = await hydrateEmployeeGrants([grant]);
  if (!hydrated) throw new VaultError("AI Employee not found", 404);
  return hydrated;
}

export async function deleteEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  grantId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; employeeId: string; accessLevel: EmployeeVaultAccessLevel }> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  const grant = await repo.findOneBy({
    id: args.grantId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!grant) throw new VaultError("Vault Grant not found", 404);
  await repo.delete({ id: grant.id });
  return { id: grant.id, employeeId: grant.employeeId, accessLevel: grant.accessLevel };
}

/**
 * AI-facing metadata discovery. It returns only items explicitly granted to
 * the employee and never includes the encrypted payload's secret field.
 */
export async function listVaultItemsForEmployee(
  companyId: string,
  employeeId: string,
): Promise<
  Array<{
    id: string;
    type: VaultItemType;
    title: string;
    username: string;
    websiteUrl: string;
    accessLevel: EmployeeVaultAccessLevel;
  }>
> {
  await assertCompanyEmployee(companyId, employeeId);
  const grants = await AppDataSource.getRepository(EmployeeVaultGrant).find({
    where: { companyId, employeeId },
  });
  if (grants.length === 0) return [];
  const rows = await AppDataSource.getRepository(VaultItem).find({
    where: { companyId, id: In(grants.map((grant) => grant.vaultItemId)) },
  });
  const grantByItem = new Map(grants.map((grant) => [grant.vaultItemId, grant]));
  return rows.flatMap((row) => {
    const grant = grantByItem.get(row.id);
    const rank = grant ? EMPLOYEE_VAULT_ACCESS_RANK[grant.accessLevel] : undefined;
    if (!grant || typeof rank !== "number") return [];
    const payload = decryptPayload(row);
    return [
      {
        id: row.id,
        type: row.type,
        title: payload.title,
        username: payload.username,
        websiteUrl: payload.websiteUrl,
        accessLevel: grant.accessLevel,
      },
    ];
  });
}

/**
 * Sensitive resolution seam for a governed server-side AI action (for
 * example, filling the App-owned browser). Callers must never serialize the
 * returned payload into a model tool result, transcript, audit row or log.
 */
export async function getVaultItemPayloadForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  required?: EmployeeVaultAccessLevel;
}): Promise<{
  item: VaultItem;
  payload: VaultPayload;
  accessLevel: EmployeeVaultAccessLevel;
}> {
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const required = args.required ?? "use";
  const [item, grant] = await Promise.all([
    AppDataSource.getRepository(VaultItem).findOneBy({
      id: args.itemId,
      companyId: args.companyId,
    }),
    AppDataSource.getRepository(EmployeeVaultGrant).findOneBy({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      employeeId: args.employeeId,
    }),
  ]);
  if (!item || !grant) throw new VaultError("No Grant for that Vault item", 403);
  const have = EMPLOYEE_VAULT_ACCESS_RANK[grant.accessLevel];
  const need = EMPLOYEE_VAULT_ACCESS_RANK[required];
  if (typeof have !== "number" || have < need) {
    throw new VaultError(`The "${required}" Vault Grant level is required`, 403);
  }
  return { item, payload: decryptPayload(item), accessLevel: grant.accessLevel };
}

/**
 * Resolve one credential field for an App-owned, server-side action. The
 * plaintext return is intentionally narrow and ephemeral: callers must pass it
 * directly to the governed sink (such as Playwright `fill`) and must never put
 * it in a model result, response body, transcript, audit row, or log.
 */
export async function getVaultFieldForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  field: "username" | "secret";
}): Promise<string> {
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "use",
  });
  return resolved.payload[args.field];
}

/**
 * Store a login captured or generated during an AI Employee's browser flow.
 * The creator receives a `manage` Grant atomically. A missing secret is
 * generated server-side and is deliberately not included in the return value.
 */
export async function createVaultLoginForEmployee(args: {
  companyId: string;
  employeeId: string;
  title: string;
  username?: string;
  secret?: string;
  passwordLength?: number;
  websiteUrl?: string;
  notes?: string;
  visibility?: VaultItemVisibility;
}): Promise<{
  id: string;
  companyId: string;
  type: "login";
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  createdByEmployeeId: string;
  grantAccessLevel: "manage";
  createdAt: Date;
  updatedAt: Date;
}> {
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const secret = args.secret ?? generateVaultPassword(args.passwordLength);
  if (!secret) throw new VaultError("A captured secret cannot be empty", 400);
  const payload: VaultPayload = {
    title: args.title.trim(),
    username: args.username ?? "",
    secret,
    websiteUrl: normalizeVaultWebsiteUrl(args.websiteUrl ?? ""),
    notes: args.notes ?? "",
  };
  if (!payload.title) throw new VaultError("A title is required", 400);

  const saved = await AppDataSource.transaction(async (manager) => {
    const itemRepo = manager.getRepository(VaultItem);
    const item = itemRepo.create({
      companyId: args.companyId,
      type: "login",
      visibility: args.visibility ?? "company",
      encryptedPayload: encryptPayload(args.companyId, payload),
      createdByUserId: null,
      createdByEmployeeId: args.employeeId,
    });
    await itemRepo.save(item);
    const grantRepo = manager.getRepository(EmployeeVaultGrant);
    await grantRepo.save(
      grantRepo.create({
        companyId: args.companyId,
        vaultItemId: item.id,
        employeeId: args.employeeId,
        accessLevel: "manage",
      }),
    );
    return item;
  });

  return {
    id: saved.id,
    companyId: saved.companyId,
    type: "login",
    visibility: saved.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    createdByEmployeeId: args.employeeId,
    grantAccessLevel: "manage",
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

/**
 * Let an AI Employee with a `manage` Grant maintain login metadata without
 * gaining a plaintext read or rotation primitive. The existing secret is
 * decrypted only inside this service and immediately re-encrypted unchanged.
 */
export async function updateVaultLoginMetadataForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  patch: {
    title?: string;
    username?: string;
    notes?: string;
  };
}): Promise<{
  id: string;
  companyId: string;
  type: "login";
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  createdByEmployeeId: string | null;
  accessLevel: "manage";
  createdAt: Date;
  updatedAt: Date;
}> {
  if (Object.keys(args.patch).length === 0) {
    throw new VaultError("Provide at least one metadata field to update", 400);
  }
  if (Object.keys(args.patch).some((field) => !["title", "username", "notes"].includes(field))) {
    throw new VaultError("AI Employees cannot change a Vault login's saved website", 403);
  }
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "manage",
  });
  if (resolved.item.type !== "login") {
    throw new VaultError("Only Vault login metadata can be updated this way", 400);
  }

  const payload: VaultPayload = {
    title: args.patch.title?.trim() ?? resolved.payload.title,
    username: args.patch.username ?? resolved.payload.username,
    secret: resolved.payload.secret,
    websiteUrl: resolved.payload.websiteUrl,
    notes: args.patch.notes ?? resolved.payload.notes,
  };
  if (!payload.title) throw new VaultError("A title is required", 400);

  const repo = AppDataSource.getRepository(VaultItem);
  const update = await repo.update(
    {
      id: resolved.item.id,
      companyId: args.companyId,
      version: resolved.item.version,
    },
    {
      encryptedPayload: encryptPayload(args.companyId, payload),
      version: resolved.item.version + 1,
    },
  );
  if (update.affected !== 1) {
    throw new VaultError("This Vault login changed while it was being updated. Retry safely.", 409);
  }
  const saved = await loadItem(args.companyId, args.itemId);
  return {
    id: saved.id,
    companyId: saved.companyId,
    type: "login",
    visibility: saved.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    createdByEmployeeId: saved.createdByEmployeeId,
    accessLevel: "manage",
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}
