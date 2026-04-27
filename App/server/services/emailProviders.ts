import { AppDataSource } from "../db/datasource.js";
import {
  EmailProvider,
  EmailProviderKind,
  EmailProviderTestStatus,
} from "../db/entities/EmailProvider.js";
import { encryptSecret } from "../lib/secret.js";
import {
  EmailProviderConfig,
  maskedProviderSummary,
  validateProviderConfig,
} from "./emailTransports.js";
import { decryptProviderConfig } from "./email.js";

/**
 * Service layer for `EmailProvider` rows. Wraps the repo with:
 *  - encrypt/decrypt of the config blob (same sessionSecret-derived key as
 *    Secrets / IntegrationConnections).
 *  - default-row uniqueness — enabling `isDefault` on one row clears it on
 *    the others atomically.
 *  - DTO shaping that masks credentials so the client never sees raw keys.
 */

export type EmailProviderDTO = {
  id: string;
  companyId: string;
  name: string;
  kind: EmailProviderKind;
  fromAddress: string;
  replyTo: string;
  isDefault: boolean;
  enabled: boolean;
  /** Masked subset of the config — host, domain, masked api key, etc. */
  configPreview: Record<string, string>;
  lastTestedAt: string | null;
  lastTestStatus: EmailProviderTestStatus | null;
  lastTestMessage: string;
  createdAt: string;
  updatedAt: string;
};

export function serializeProvider(p: EmailProvider): EmailProviderDTO {
  let configPreview: Record<string, string> = {};
  try {
    const cfg = decryptProviderConfig(p);
    configPreview = maskedProviderSummary(cfg.kind, cfg.config);
  } catch {
    configPreview = {};
  }
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    kind: p.kind,
    fromAddress: p.fromAddress,
    replyTo: p.replyTo,
    isDefault: p.isDefault,
    enabled: p.enabled,
    configPreview,
    lastTestedAt: p.lastTestedAt ? p.lastTestedAt.toISOString() : null,
    lastTestStatus: p.lastTestStatus,
    lastTestMessage: p.lastTestMessage,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listProviders(
  companyId: string,
): Promise<EmailProvider[]> {
  return AppDataSource.getRepository(EmailProvider).find({
    where: { companyId },
    order: { isDefault: "DESC", createdAt: "ASC" },
  });
}

export async function getProvider(
  companyId: string,
  id: string,
): Promise<EmailProvider | null> {
  return AppDataSource.getRepository(EmailProvider).findOneBy({
    companyId,
    id,
  });
}

export async function createProvider(args: {
  companyId: string;
  name: string;
  kind: EmailProviderKind;
  fromAddress: string;
  replyTo?: string;
  rawConfig: Record<string, unknown>;
  isDefault?: boolean;
  enabled?: boolean;
}): Promise<EmailProvider> {
  const validated = validateProviderConfig(args.kind, args.rawConfig);
  const repo = AppDataSource.getRepository(EmailProvider);
  const row = repo.create({
    companyId: args.companyId,
    name: args.name.trim(),
    kind: args.kind,
    fromAddress: args.fromAddress.trim(),
    replyTo: (args.replyTo ?? "").trim(),
    encryptedConfig: encryptProviderConfig(validated),
    isDefault: false,
    enabled: args.enabled ?? true,
  });
  await repo.save(row);
  if (args.isDefault) {
    await setDefault(args.companyId, row.id);
    return (await repo.findOneByOrFail({ id: row.id }));
  }
  // If this is the only provider, auto-default it so callers don't have to
  // tick the box explicitly for the common case.
  const count = await repo.count({ where: { companyId: args.companyId } });
  if (count === 1) {
    await setDefault(args.companyId, row.id);
    return (await repo.findOneByOrFail({ id: row.id }));
  }
  return row;
}

export async function updateProvider(
  row: EmailProvider,
  patch: {
    name?: string;
    fromAddress?: string;
    replyTo?: string;
    rawConfig?: Record<string, unknown>;
    isDefault?: boolean;
    enabled?: boolean;
  },
): Promise<EmailProvider> {
  const repo = AppDataSource.getRepository(EmailProvider);
  if (typeof patch.name === "string") row.name = patch.name.trim();
  if (typeof patch.fromAddress === "string")
    row.fromAddress = patch.fromAddress.trim();
  if (typeof patch.replyTo === "string") row.replyTo = patch.replyTo.trim();
  if (patch.rawConfig) {
    const validated = validateProviderConfig(row.kind, patch.rawConfig);
    row.encryptedConfig = encryptProviderConfig(validated);
    // A successful re-save clears stale "failed" test status so the UI
    // stops yelling until the next test.
    row.lastTestStatus = null;
    row.lastTestMessage = "";
  }
  if (typeof patch.enabled === "boolean") row.enabled = patch.enabled;
  await repo.save(row);
  if (patch.isDefault === true) {
    await setDefault(row.companyId, row.id);
    return (await repo.findOneByOrFail({ id: row.id }));
  }
  if (patch.isDefault === false && row.isDefault) {
    row.isDefault = false;
    await repo.save(row);
  }
  return row;
}

export async function deleteProvider(
  companyId: string,
  id: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(EmailProvider);
  const existing = await repo.findOneBy({ companyId, id });
  if (!existing) return false;
  await repo.delete({ id });
  // If we just removed the default, promote the most-recently-created
  // remaining provider so the company isn't silently un-defaulted.
  if (existing.isDefault) {
    const next = await repo.findOne({
      where: { companyId },
      order: { createdAt: "ASC" },
    });
    if (next) {
      next.isDefault = true;
      await repo.save(next);
    }
  }
  return true;
}

export async function setDefault(
  companyId: string,
  id: string,
): Promise<void> {
  const repo = AppDataSource.getRepository(EmailProvider);
  await repo
    .createQueryBuilder()
    .update(EmailProvider)
    .set({ isDefault: false })
    .where("companyId = :companyId AND id != :id", { companyId, id })
    .execute();
  await repo
    .createQueryBuilder()
    .update(EmailProvider)
    .set({ isDefault: true, enabled: true })
    .where("companyId = :companyId AND id = :id", { companyId, id })
    .execute();
}

export async function recordTestResult(
  row: EmailProvider,
  status: EmailProviderTestStatus,
  message: string,
): Promise<EmailProvider> {
  row.lastTestedAt = new Date();
  row.lastTestStatus = status;
  row.lastTestMessage = message;
  return AppDataSource.getRepository(EmailProvider).save(row);
}

function encryptProviderConfig(cfg: EmailProviderConfig): string {
  return encryptSecret(JSON.stringify(cfg.config));
}
