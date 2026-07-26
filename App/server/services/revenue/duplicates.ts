import { In, IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { RevenueCustomField } from "../../db/entities/RevenueCustomField.js";
import { RevenueCustomValue } from "../../db/entities/RevenueCustomValue.js";
import {
  RevenueDuplicateCandidate,
} from "../../db/entities/RevenueDuplicateCandidate.js";
import { RevenueFieldEvidence } from "../../db/entities/RevenueFieldEvidence.js";
import { RevenueRecordAlias } from "../../db/entities/RevenueRecordAlias.js";
import type { MergeResourceType } from "./merge.js";

type Reason = { kind: string; value?: string; score: number };

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

async function upsertCandidate(
  companyId: string,
  resourceType: MergeResourceType,
  leftId: string,
  rightId: string,
  reasons: Reason[],
): Promise<"created" | "updated" | "unchanged"> {
  if (leftId === rightId || reasons.length === 0) return "unchanged";
  const [sortedLeftId, sortedRightId] = [leftId, rightId].sort();
  const repo = AppDataSource.getRepository(RevenueDuplicateCandidate);
  const existing = await repo.findOneBy({
    companyId,
    resourceType,
    leftId: sortedLeftId,
    rightId: sortedRightId,
  });
  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.score, 0),
  );
  if (existing) {
    const prior = JSON.parse(existing.reasonsJson || "[]") as Reason[];
    const merged = new Map([...prior, ...reasons].map((reason) => [JSON.stringify(reason), reason]));
    const nextReasons = [...merged.values()];
    const nextScore = Math.max(
      existing.score,
      Math.min(
        100,
        nextReasons.reduce((total, reason) => total + reason.score, 0),
      ),
    );
    if (nextScore === existing.score && nextReasons.length === prior.length) return "unchanged";
    existing.score = nextScore;
    existing.reasonsJson = JSON.stringify(nextReasons);
    if (existing.status === "dismissed") existing.status = "open";
    await repo.save(existing);
    return "updated";
  }
  await repo.save(
    repo.create({
      companyId,
      resourceType,
      leftId: sortedLeftId,
      rightId: sortedRightId,
      score,
      reasonsJson: JSON.stringify(reasons),
      status: "open",
      mergeOperationId: null,
      detectedAt: new Date(),
      resolvedAt: null,
      resolvedByUserId: null,
    }),
  );
  return "created";
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
  const pairReasons = new Map<string, { type: MergeResourceType; leftId: string; rightId: string; reasons: Reason[] }>();
  const add = (type: MergeResourceType, leftId: string, rightId: string, reason: Reason) => {
    const [left, right] = [leftId, rightId].sort();
    const key = `${type}:${left}:${right}`;
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
  )) add("account", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    accounts,
    (account) => normalizedName(account.name) || null,
    (name) => ({ kind: "normalized_name", value: name, score: 60 }),
  )) add("account", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    contacts,
    (contact) => contact.email || null,
    (email) => ({ kind: "exact_email", value: email, score: 100 }),
  )) add("contact", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    partnerships,
    (partnership) => normalizedName(partnership.name) || null,
    (name) => ({ kind: "normalized_name", value: name, score: 70 }),
  )) add("partnership", pair.leftId, pair.rightId, pair.reason);
  for (const pair of await groupPairs(
    partnerships,
    (partnership) => partnership.websiteUrl.toLowerCase() || null,
    (website) => ({ kind: "exact_website", value: website, score: 100 }),
  )) add("partnership", pair.leftId, pair.rightId, pair.reason);

  const accountDomainOwners = new Map<string, Set<string>>();
  for (const account of accounts) {
    if (account.domain) accountDomainOwners.set(account.domain, new Set([account.id]));
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
    if (contact.email) contactEmailOwners.set(contact.email, new Set([contact.id]));
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

  const stripeField = await AppDataSource.getRepository(RevenueCustomField).findOneBy({
    companyId,
    resourceType: "account",
    key: "stripe_customer_id",
  });
  if (stripeField) {
    const values = await AppDataSource.getRepository(RevenueCustomValue).find({
      where: { companyId, fieldId: stripeField.id },
    });
    for (const pair of await groupPairs(
      values,
      (value) => value.searchValue || null,
      (customerId) => ({ kind: "stripe_customer_id", value: customerId, score: 100 }),
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

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const pair of pairReasons.values()) {
    const result = await upsertCandidate(
      companyId,
      pair.type,
      pair.leftId,
      pair.rightId,
      pair.reasons,
    );
    if (result === "created") created += 1;
    else if (result === "updated") updated += 1;
    else unchanged += 1;
  }
  return { created, updated, unchanged, evaluatedPairs: pairReasons.size };
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
