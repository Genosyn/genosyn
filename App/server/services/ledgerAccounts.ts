import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Account, type AccountType } from "../db/entities/Account.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";

/**
 * Adding to and changing the chart of accounts — Finance → Accounts, and the
 * `create_finance_account` / `update_finance_account` AI tools, through one set
 * of rules.
 *
 * An AI Employee filing a Banking queue used to stop at "still waiting on
 * you: three accounts" — 1400 Digital Assets, 1500 Due from Affiliate, 6085
 * Rent — because nothing it could call added an account, so the purchases,
 * transfers and rent that belonged in them could not be filed at all. A
 * Member with full Finance access adds one in a click; an AI Employee holding
 * the same Grant now can too, under the same rules: codes stay unique, the
 * accounts auto-posting depends on keep their codes and types, and an account
 * that still carries a balance is never archived out of the reports.
 */

export const ACCOUNT_TYPES: [AccountType, ...AccountType[]] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

export const accountCodeSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash or underscore, e.g. 6085 or 1100-01");

export const accountWriteSchema = z.object({
  code: accountCodeSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().uuid().nullable().optional(),
});

export const accountPatchSchema = accountWriteSchema
  .partial()
  .extend({ archived: z.boolean().optional() });

export type AccountWrite = z.infer<typeof accountWriteSchema>;
export type AccountPatch = z.infer<typeof accountPatchSchema>;

/** A change the chart of accounts refuses, with the status it answers. */
export class LedgerAccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "LedgerAccountError";
  }
}

async function assertParent(companyId: string, parentId: string, self?: string): Promise<void> {
  if (parentId === self) throw new LedgerAccountError("An account cannot be its own parent", 400);
  const parent = await AppDataSource.getRepository(Account).findOneBy({ id: parentId, companyId });
  if (!parent) throw new LedgerAccountError("Invalid parent account", 400);
}

async function assertCodeFree(companyId: string, code: string): Promise<void> {
  const taken = await AppDataSource.getRepository(Account).findOneBy({ companyId, code });
  if (taken) {
    throw new LedgerAccountError(
      `An account with code ${code} already exists: ${taken.code} ${taken.name}`,
      409,
    );
  }
}

/** Add an account to the company's chart of accounts. */
export async function createLedgerAccount(
  companyId: string,
  input: AccountWrite,
): Promise<Account> {
  await assertCodeFree(companyId, input.code);
  if (input.parentId) await assertParent(companyId, input.parentId);
  const repo = AppDataSource.getRepository(Account);
  return repo.save(
    repo.create({
      companyId,
      code: input.code,
      name: input.name,
      type: input.type,
      parentId: input.parentId ?? null,
      isSystem: false,
    }),
  );
}

/** One account of this company, or null. */
export async function loadLedgerAccount(companyId: string, id: string): Promise<Account | null> {
  return AppDataSource.getRepository(Account).findOneBy({ id, companyId });
}

/**
 * Rename, renumber, retype, re-parent, archive or restore an account. The
 * system accounts auto-posting looks up by code keep their code and type and
 * are never archived, and an account that still carries a balance is not
 * archived: every report leaves archived accounts out, so its balance would
 * silently drop off the trial balance and the books would stop balancing.
 */
export async function updateLedgerAccount(account: Account, patch: AccountPatch): Promise<Account> {
  if (patch.code !== undefined && patch.code !== account.code) {
    if (account.isSystem) {
      throw new LedgerAccountError(
        "System account codes cannot be renumbered — auto-post depends on them",
        409,
      );
    }
    await assertCodeFree(account.companyId, patch.code);
    account.code = patch.code;
  }
  if (patch.name !== undefined) account.name = patch.name;
  if (patch.type !== undefined && patch.type !== account.type) {
    if (account.isSystem) throw new LedgerAccountError("System account types cannot change", 409);
    account.type = patch.type;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId) await assertParent(account.companyId, patch.parentId, account.id);
    account.parentId = patch.parentId;
  }
  if (patch.archived !== undefined) {
    if (account.isSystem && patch.archived) {
      throw new LedgerAccountError("System accounts cannot be archived", 409);
    }
    if (patch.archived && !account.archivedAt) {
      const lines = await AppDataSource.getRepository(LedgerLine).find({
        where: { accountId: account.id },
        select: ["debitCents", "creditCents"],
      });
      const balance = lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0);
      if (balance !== 0) {
        throw new LedgerAccountError(
          "This account still has a balance. Move its balance to another account with a journal entry before archiving it.",
          409,
        );
      }
    }
    account.archivedAt = patch.archived ? (account.archivedAt ?? new Date()) : null;
  }
  return AppDataSource.getRepository(Account).save(account);
}
