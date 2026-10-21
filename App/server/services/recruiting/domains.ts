import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";

import { IsNull, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { getEffectiveInstanceSecrets } from "../../lib/instanceSecrets.js";
import { getPublicUrl } from "../publicUrl.js";
import { RecruitingConflictError, RecruitingValidationError } from "./errors.js";

/**
 * A careers site on the company's own domain — `careers.example.com` — and
 * the proof that the company may put it there.
 *
 * Pointing a domain at this install is not enough to claim it: on an install
 * that runs several Companies, the first one to type a domain would otherwise
 * own it. So a domain is served only after the company publishes a TXT record
 * at `_genosyn-careers.<domain>` carrying the token this module generated,
 * the same proof Google, Vercel and every mail provider ask for. Changing the
 * domain starts the proof over.
 *
 * The verified domains are cached in memory, keyed by host name, so the
 * request path can decide synchronously which site a `Host` header names
 * (the `services/publicUrl.ts` pattern: refreshed every 30 seconds and on
 * every change made by this process).
 */

export const CAREERS_TXT_LABEL = "_genosyn-careers";
export const CAREERS_TXT_VALUE_PREFIX = "genosyn-careers-verify=";

const REFRESH_INTERVAL_MS = 30_000;

let hostToCompany = new Map<string, string>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A host name a company can put a careers site on, lower-cased and
 * IDNA-encoded, or a refusal that says what to type instead. Accepts what
 * people paste — a URL, a trailing dot, a port — and keeps only the name.
 */
export function normalizeCustomDomain(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) throw new RecruitingValidationError("Enter a domain, like careers.example.com.");
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "").replace(/\.$/, "");
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    throw new RecruitingValidationError(`"${input.trim()}" is not a domain name.`);
  }
  if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) {
    throw new RecruitingValidationError("Use a domain name, not an IP address.");
  }
  const labels = host.split(".");
  if (
    host.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1] ?? "")
  ) {
    throw new RecruitingValidationError(`"${input.trim()}" is not a domain name.`);
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new RecruitingValidationError("Use a public domain name, not localhost.");
  }
  let installHost = "";
  try {
    installHost = new URL(getPublicUrl()).hostname.toLowerCase();
  } catch {
    installHost = "";
  }
  if (host === installHost) {
    throw new RecruitingValidationError(
      "That is this install's own address. Use a separate domain for the careers site, like careers.example.com.",
    );
  }
  return host;
}

/** The DNS record a company publishes to prove a domain is theirs. */
export function domainVerificationRecord(domain: string, token: string) {
  return {
    type: "TXT" as const,
    name: `${CAREERS_TXT_LABEL}.${domain}`,
    value: `${CAREERS_TXT_VALUE_PREFIX}${token}`,
  };
}

/** The host a careers domain should point at with a CNAME: the install's own. */
export function domainTargetHost(): string {
  try {
    return new URL(getPublicUrl()).hostname;
  } catch {
    return "";
  }
}

/**
 * The TXT value a company proves a domain with. The same company and domain
 * always get the same one, so when someone else's unproven claim pushes the
 * domain back and forth, the record the owner already published stays right.
 */
function domainToken(companyId: string, domain: string): string {
  return crypto
    .createHmac("sha256", getEffectiveInstanceSecrets().encryptionSecret)
    .update(`careers-domain:${companyId}:${domain}`)
    .digest("hex")
    .slice(0, 32);
}

function domainTaken(domain: string): RecruitingConflictError {
  return new RecruitingConflictError(`${domain} is already connected to another company on this install.`);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : "";
  return code === "23505" || code.startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint/i.test(message);
}

/**
 * Connect, change or remove a company's careers domain. A new domain gets a
 * new token and starts unverified; the same domain again changes nothing.
 *
 * A domain another company has *proven* is refused. One another company has
 * only typed is not theirs to keep: typing a name proves nothing, so an
 * unproven claim yields to the next company that asks, and whichever of them
 * publishes the TXT record first keeps it.
 */
export async function setCustomDomain(
  settings: RecruitingSettings,
  input: string | null,
): Promise<RecruitingSettings> {
  const repo = AppDataSource.getRepository(RecruitingSettings);
  if (input === null || input.trim() === "") {
    const removed = {
      customDomain: null,
      customDomainToken: null,
      customDomainVerifiedAt: null,
      customDomainCheckedAt: null,
      customDomainError: "",
    };
    await repo.update({ id: settings.id }, removed);
    Object.assign(settings, removed);
    await refreshCareersHosts();
    return (await repo.findOneBy({ id: settings.id })) ?? settings;
  }
  const domain = normalizeCustomDomain(input);
  if (settings.customDomain === domain) return settings;
  const holder = await repo.findOneBy({ customDomain: domain });
  if (holder && holder.companyId !== settings.companyId) {
    const released = holder.customDomainVerifiedAt
      ? null
      : await repo.update(
          { id: holder.id, customDomain: domain, customDomainVerifiedAt: IsNull() },
          {
            customDomain: null,
            customDomainToken: null,
            customDomainCheckedAt: null,
            customDomainError: "",
          },
        );
    if (!released?.affected) {
      // Proven, or proven since we looked: unless it has moved on meanwhile, it is theirs.
      const current = await repo.findOneBy({ customDomain: domain });
      if (current && current.companyId !== settings.companyId) throw domainTaken(domain);
    }
  }
  const claim = {
    customDomain: domain,
    customDomainToken: domainToken(settings.companyId, domain),
    customDomainVerifiedAt: null,
    customDomainCheckedAt: null,
    customDomainError: "",
  };
  try {
    // One statement, outside any transaction: when two companies claim the
    // same name at once the unique index picks one, and the other's failure
    // cannot roll back the winner's write on SQLite's shared connection.
    await repo.update({ id: settings.id }, claim);
  } catch (error) {
    if (isUniqueViolation(error)) throw domainTaken(domain);
    throw error;
  }
  Object.assign(settings, claim);
  await refreshCareersHosts();
  return (await repo.findOneBy({ id: settings.id })) ?? settings;
}

/** The two lookups verification makes; tests pass their own. */
export type CareersDnsResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
};

const systemResolver: CareersDnsResolver = {
  resolveTxt: (name) => dns.promises.resolveTxt(name),
  resolveCname: (name) => dns.promises.resolveCname(name),
};

let resolverForTests: CareersDnsResolver | null = null;

/** Route tests check a domain without reaching real DNS. */
export function setCareersDnsResolverForTests(resolver: CareersDnsResolver | null): void {
  resolverForTests = resolver;
}

function dnsMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
}

export type DomainCheck = {
  verified: boolean;
  /** Where the domain's CNAME points, when it has one; for the setup checklist. */
  cnameTargets: string[];
  /** True when the CNAME names this install's host. */
  pointsHere: boolean;
};

/**
 * Look for the TXT record now. A domain that was verified stays verified when
 * a later check cannot see the record — DNS has bad minutes, and a careers
 * site that disappears because a resolver hiccupped helps nobody. Only
 * changing the domain takes verification away.
 *
 * DNS can take seconds, and the company may change or remove its domain in
 * the meantime. So the check writes only what it learned — when it looked,
 * what went wrong, the first time it found the record — and only while the
 * same domain and token are still connected. A check that finds the row
 * moved on reports nothing about the new domain and leaves it as it is.
 */
export async function verifyCustomDomain(
  settings: RecruitingSettings,
  resolver: CareersDnsResolver = resolverForTests ?? systemResolver,
): Promise<{ settings: RecruitingSettings; check: DomainCheck }> {
  if (!settings.customDomain || !settings.customDomainToken) {
    throw new RecruitingValidationError("Connect a domain before checking it.");
  }
  const checked = {
    id: settings.id,
    customDomain: settings.customDomain,
    customDomainToken: settings.customDomainToken,
  };
  const record = domainVerificationRecord(checked.customDomain, checked.customDomainToken);
  let found = false;
  let error = "";
  try {
    const records = await resolver.resolveTxt(record.name);
    const values = records.map((chunks) => chunks.join("").trim());
    found = values.includes(record.value);
    if (!found) {
      error = values.length
        ? `Found a TXT record at ${record.name}, but none of its values is ${record.value}. Check for a typo or an extra quote.`
        : `No TXT record at ${record.name} yet. DNS changes can take a few minutes to appear.`;
    }
  } catch (cause) {
    error = dnsMissing(cause)
      ? `No TXT record at ${record.name} yet. DNS changes can take a few minutes to appear.`
      : `DNS lookup for ${record.name} failed (${(cause as Error)?.message ?? "unknown error"}). Try again in a minute.`;
  }

  let cnameTargets: string[] = [];
  try {
    cnameTargets = (await resolver.resolveCname(checked.customDomain)).map((target) =>
      target.toLowerCase().replace(/\.$/, ""),
    );
  } catch {
    cnameTargets = [];
  }
  const target = domainTargetHost().toLowerCase();

  const repo = AppDataSource.getRepository(RecruitingSettings);
  const checkedAt = new Date();
  const written = await repo.update(checked, {
    customDomainCheckedAt: checkedAt,
    customDomainError: found ? "" : error,
  });
  const current = Boolean(written.affected);
  if (found && current) {
    // The first proof stands: a later check never moves the verification time.
    await repo.update(
      { ...checked, customDomainVerifiedAt: IsNull() },
      { customDomainVerifiedAt: checkedAt },
    );
  }
  await refreshCareersHosts();
  const saved = (await repo.findOneBy({ id: settings.id })) ?? settings;
  if (!current) {
    // The domain changed (or went) while DNS answered: this check was about
    // a domain the company no longer has, so it says nothing about the new one.
    return { settings: saved, check: { verified: false, cnameTargets: [], pointsHere: false } };
  }
  return {
    settings: saved,
    check: {
      verified: Boolean(saved.customDomainVerifiedAt),
      cnameTargets,
      pointsHere: Boolean(target) && cnameTargets.includes(target),
    },
  };
}

/** True when this domain serves the company's careers site right now. */
export function customDomainLive(settings: RecruitingSettings | null): boolean {
  return Boolean(
    settings?.customDomain &&
      settings.customDomainVerifiedAt &&
      settings.siteEnabled &&
      settings.siteVisibility === "public",
  );
}

/** Rebuild the host map from the database. */
export async function refreshCareersHosts(): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  const rows = await AppDataSource.getRepository(RecruitingSettings).find({
    where: { customDomain: Not(IsNull()), customDomainVerifiedAt: Not(IsNull()) },
    select: {
      companyId: true,
      customDomain: true,
      customDomainVerifiedAt: true,
      siteEnabled: true,
      siteVisibility: true,
    },
  });
  const next = new Map<string, string>();
  for (const row of rows) {
    if (customDomainLive(row as RecruitingSettings)) next.set(row.customDomain as string, row.companyId);
  }
  hostToCompany = next;
}

/** Load before the server accepts requests, then keep every replica fresh. */
export async function bootCareersHosts(): Promise<void> {
  await refreshCareersHosts();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshCareersHosts().catch((err: unknown) => {
      // Keep the last known map through a transient database failure.
      // eslint-disable-next-line no-console
      console.warn(
        `[careers] host refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/** The host part of a `Host` header: lower-cased, without a port. */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d+$/, "").replace(/\.$/, "");
}

/** The company whose live careers site this host is, or null. Synchronous. */
export function careersCompanyForHost(hostHeader: string | undefined): string | null {
  const host = hostnameOf(hostHeader);
  return host ? (hostToCompany.get(host) ?? null) : null;
}
