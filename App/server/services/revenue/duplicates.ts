import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import { RevenueDuplicateCandidate } from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueRecordAlias } from "../../db/entities/RevenueRecordAlias.js";
import type { MergeResourceType } from "./merge.js";

type Reason = { kind: string; value?: string; score: number };

type CandidatePair = {
  type: MergeResourceType;
  leftId: string;
  rightId: string;
  reasons: Reason[];
};

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(incorporated|inc|limited|ltd|llc|corp|corporation|company|co)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function titleTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

function similarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return [...a].filter((token) => b.has(token)).length / union.size;
}

function candidateKey(resourceType: MergeResourceType, leftId: string, rightId: string): string {
  const [left, right] = [leftId, rightId].sort();
  return `${resourceType}:${left}:${right}`;
}

function canonicalReasons(reasons: Reason[]): Reason[] {
  return [...new Map(reasons.map((reason) => [JSON.stringify(reason), reason])).values()].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function candidateEvidence(reasons: Reason[]): { reasonsJson: string; score: number } {
  const canonical = canonicalReasons(reasons);
  return {
    reasonsJson: JSON.stringify(canonical),
    score: Math.min(
      100,
      canonical.reduce((total, reason) => total + reason.score, 0),
    ),
  };
}

async function groupPairs<T extends { id: string }>(
  rows: T[],
  keyOf: (row: T) => string | null,
  reason: (key: string) => Reason,
): Promise<Array<{ leftId: string; rightId: string; reason: Reason }>> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const pairs: Array<{ leftId: string; rightId: string; reason: Reason }> = [];
  for (const [key, group] of groups) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        pairs.push({ leftId: group[left].id, rightId: group[right].id, reason: reason(key) });
      }
    }
  }
  return pairs;
}

export async function scanRevenueDuplicates(companyId: string): Promise<{
  created: number;
  updated: number;
  unchanged: number;
  closed: number;
  evaluatedPairs: number;
}> {
  const [accounts, contacts, deals, partnerships, aliases, domainEvidence] = await Promise.all([
    AppDataSource.getRepository(Customer).find({ where: { companyId, archivedAt: IsNull() } }),
    AppDataSource.getRepository(Contact).find({ where: { companyId, archivedAt: IsNull() } }),
    AppDataSource.getRepository(Deal).find({ where: { companyId, archivedAt: IsNull() } }),
    AppDataSource.getRepository(Partnership).find({ where: { companyId, archivedAt: IsNull() } }),
    AppDataSource.getRepository(RevenueRecordAlias).find({ where: { companyId } }),
    AppDataSource.getRepository(RevenueFieldEvidence).find({
      where: {
        companyId,
        resourceType: "account",
        fieldKey: "domain",
        sourceType: "website",
        status: In(["proposed", "accepted"]),
      },
    }),
  ]);
  const activeIds = {
    account: new Set(accounts.map((row) => row.id)),
    contact: new Set(contacts.map((row) => row.id)),
    deal: new Set(deals.map((row) => row.id)),
    partnership: new Set(partnerships.map((row) => row.id)),
  };
  const pairReasons = new Map<string, CandidatePair>();
  const add = (type: MergeResourceType, leftId: string, rightId: string, reason: Reason) => {
    if (leftId === rightId) return;
    if (!activeIds[type].has(leftId) || !activeIds[type].has(rightId)) return;
    const [left, right] = [leftId, rightId].sort();
    const key = candidateKey(type, left, right);
    const item = pairReasons.get(key) ?? { type, leftId: left, rightId: right, reasons: [] };
    if (!item.reasons.some((existing) => JSON.stringify(existing) === JSON.stringify(reason))) {
      item.reasons.push(reason);
    }
    pairReasons.set(key, item);
  };

  for (const pair of await groupPairs(
    accounts,
    (account) => account.domain || null,
    (domain) => ({ kind: "exact_domain", value: domain, score: 100 }),
  ))
    add("account", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    accounts,
    (account) => normalizedName(account.name) || null,
    (name) => ({ kind: "normalized_name", value: name, score: 60 }),
  ))
    add("account", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    contacts,
    (contact) => contact.email || null,
    (email) => ({ kind: "exact_email", value: email, score: 100 }),
  ))
    add("contact", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    partnerships,
    (partnership) => normalizedName(partnership.name) || null,
    (name) => ({ kind: "normalized_name", value: name, score: 70 }),
  ))
    add("partnership", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    partnerships,
    (partnership) => partnership.websiteUrl.toLowerCase() || null,
    (website) => ({ kind: "exact_website", value: website, score: 100 }),
  ))
    add("partnership", pair.leftId, pair.rightId, pair.reason);

  const accountDomainOwners = new Map<string, Set<string>>();
  for (const account of accounts) {
    if (!account.domain) continue;
    const owners = accountDomainOwners.get(account.domain) ?? new Set<string>();
    owners.add(account.id);
    accountDomainOwners.set(account.domain, owners);
  }
  for (const alias of aliases.filter(
    (row) => row.resourceType === "account" && row.aliasType === "domain",
  )) {
    const owners = accountDomainOwners.get(alias.normalizedValue) ?? new Set<string>();
    owners.add(alias.recordId);
    accountDomainOwners.set(alias.normalizedValue, owners);
  }
  for (const evidence of domainEvidence) {
    if (!evidence.normalizedValue) continue;
    const owners = accountDomainOwners.get(evidence.normalizedValue) ?? new Set<string>();
    owners.add(evidence.resourceId);
    accountDomainOwners.set(evidence.normalizedValue, owners);
  }
  for (const [domain, owners] of accountDomainOwners) {
    const ids = [...owners];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        add("account", ids[left], ids[right], {
          kind: "aliased_domain",
          value: domain,
          score: 95,
        });
      }
    }
  }
  const contactEmailOwners = new Map<string, Set<string>>();
  for (const contact of contacts) {
    if (!contact.email) continue;
    const owners = contactEmailOwners.get(contact.email) ?? new Set<string>();
    owners.add(contact.id);
    contactEmailOwners.set(contact.email, owners);
  }
  for (const alias of aliases.filter(
    (row) => row.resourceType === "contact" && row.aliasType === "email",
  )) {
    const owners = contactEmailOwners.get(alias.normalizedValue) ?? new Set<string>();
    owners.add(alias.recordId);
    contactEmailOwners.set(alias.normalizedValue, owners);
  }
  for (const [email, owners] of contactEmailOwners) {
    const ids = [...owners];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        add("contact", ids[left], ids[right], {
          kind: "aliased_email",
          value: email,
          score: 95,
        });
      }
    }
  }

  const sourceAliases = aliases.filter((row) => row.aliasType === "source_id");
  for (const type of ["account", "contact", "deal", "partnership"] as const) {
    for (const pair of await groupPairs(
      sourceAliases.filter((alias) => alias.resourceType === type),
      (alias) => alias.normalizedValue || null,
      (sourceId) => ({ kind: "shared_source_id", value: sourceId, score: 100 }),
    )) {
      const left = sourceAliases.find((alias) => alias.id === pair.leftId);
      const right = sourceAliases.find((alias) => alias.id === pair.rightId);
      if (left && right) add(type, left.recordId, right.recordId, pair.reason);
    }
  }

  const identifierFields = await AppDataSource.getRepository(RevenueCustomField).find({
    where: { companyId, resourceType: "account" },
  });
  for (const field of identifierFields.filter((candidate) =>
    /(?:stripe|finance|billing|external|source|customer).*id/i.test(candidate.key),
  )) {
    const values = await AppDataSource.getRepository(RevenueCustomValue).find({
      where: { companyId, fieldId: field.id },
    });
    for (const pair of await groupPairs(
      values,
      (value) => value.searchValue || null,
      (externalId) => ({
        kind: `shared_${field.key}`,
        value: externalId,
        score: 100,
      }),
    )) {
      const left = values.find((value) => value.id === pair.leftId);
      const right = values.find((value) => value.id === pair.rightId);
      if (left && right) add("account", left.resourceId, right.resourceId, pair.reason);
    }
  }

  const dealsByAccount = new Map<string, Deal[]>();
  for (const deal of deals) {
    if (!deal.customerId) continue;
    const list = dealsByAccount.get(deal.customerId) ?? [];
    list.push(deal);
    dealsByAccount.set(deal.customerId, list);
  }
  for (const group of dealsByAccount.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const score = similarity(group[left].title, group[right].title);
        if (score < 0.75) continue;
        add("deal", group[left].id, group[right].id, {
          kind: "similar_title_same_account",
          value: score.toFixed(2),
          score: Math.round(score * 80),
        });
      }
    }
  }

  const reconciliation = await AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(RevenueDuplicateCandidate);
    const existing = await repo.find({ where: { companyId } });
    const existingByKey = new Map(
      existing.map((candidate) => [
        candidateKey(candidate.resourceType, candidate.leftId, candidate.rightId),
        candidate,
      ]),
    );
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const [key, pair] of pairReasons) {
      const evidence = candidateEvidence(pair.reasons);
      const candidate = existingByKey.get(key);
      if (!candidate) {
        await repo.save(
          repo.create({
            companyId,
            resourceType: pair.type,
            leftId: pair.leftId,
            rightId: pair.rightId,
            score: evidence.score,
            reasonsJson: evidence.reasonsJson,
            status: "open",
            mergeOperationId: null,
            detectedAt: new Date(),
            resolvedAt: null,
            resolvedByUserId: null,
          }),
        );
        created += 1;
        continue;
      }
      if (candidate.status === "merged") {
        unchanged += 1;
        continue;
      }
      if (candidate.score === evidence.score && candidate.reasonsJson === evidence.reasonsJson) {
        unchanged += 1;
        continue;
      }
      candidate.score = evidence.score;
      candidate.reasonsJson = evidence.reasonsJson;
      await repo.save(candidate);
      updated += 1;
    }

    // There is no stale status in the existing schema. Removing only vanished
    // open proposals keeps the live queue truthful while dismissed rows remain
    // durable pair-level memory and merged rows remain part of the audit trail.
    const stale = existing.filter(
      (candidate) =>
        candidate.status === "open" &&
        !pairReasons.has(candidateKey(candidate.resourceType, candidate.leftId, candidate.rightId)),
    );
    if (stale.length > 0) await repo.remove(stale);
    return { created, updated, unchanged, closed: stale.length };
  });
  return { ...reconciliation, evaluatedPairs: pairReasons.size };
}

export async function listRevenueDuplicateCandidates(
  companyId: string,
  opts: {
    resourceType?: MergeResourceType;
    status?: RevenueDuplicateCandidate["status"];
    minScore?: number;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: RevenueDuplicateCandidate[]; total: number }> {
  const qb = AppDataSource.getRepository(RevenueDuplicateCandidate)
    .createQueryBuilder("candidate")
    .where("candidate.companyId = :companyId", { companyId });
  if (opts.resourceType) {
    qb.andWhere("candidate.resourceType = :resourceType", {
      resourceType: opts.resourceType,
    });
  }
  if (opts.status) qb.andWhere("candidate.status = :status", { status: opts.status });
  if (opts.minScore !== undefined) {
    qb.andWhere("candidate.score >= :minScore", { minScore: opts.minScore });
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("candidate.score", "DESC")
    .addOrderBy("candidate.createdAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 100, 1), 500))
    .getMany();
  return { rows, total };
}

export async function dismissRevenueDuplicateCandidate(
  companyId: string,
  id: string,
  userId: string | null,
): Promise<RevenueDuplicateCandidate | null> {
  const repo = AppDataSource.getRepository(RevenueDuplicateCandidate);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  if (row.status === "merged") throw new Error("A merged candidate cannot be dismissed");
  row.status = "dismissed";
  row.resolvedAt = new Date();
  row.resolvedByUserId = userId;
  return repo.save(row);
}
