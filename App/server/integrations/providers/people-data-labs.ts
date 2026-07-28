import { maskSecret } from "../../lib/secret.js";
import type {
  CompanyFirmographicLookupInput,
  CompanyFirmographicParent,
  CompanyFirmographicProfile,
  IntegrationProvider,
  IntegrationRuntimeContext,
} from "../types.js";

/**
 * People Data Labs company enrichment.
 *
 * The URL is deliberately fixed. A Connection stores only the customer's API
 * key, encrypted by the Integration service, and cannot redirect requests to
 * an arbitrary host. `data_include` keeps the response to the small set of
 * fields Revenue understands instead of retaining a full provider profile.
 */
const PDL_COMPANY_ENRICH_URL = "https://api.peopledatalabs.com/v5/company/enrich";
const PDL_VALIDATION_WEBSITE = "genosyn-connection-check.invalid";
const PDL_DATA_INCLUDE = [
  "id",
  "name",
  "display_name",
  "website",
  "industry",
  "industry_v2",
  "employee_count",
  "location",
  "likelihood",
  "immediate_parent",
  "ultimate_parent",
  "affiliated_entities",
].join(",");

type PeopleDataLabsConfig = {
  apiKey: string;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_000_000_000
    ? value
    : null;
}

function normalizeDomain(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "") || null;
  } catch {
    const domain = trimmed
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      ?.split("?")[0]
      ?.split("#")[0]
      ?.trim();
    return domain || null;
  }
}

function normalizeWebsite(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function uniqueParts(parts: Array<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}

function formatHeadquarters(value: unknown): string | null {
  const location = objectValue(value);
  if (!location) return null;
  const street = uniqueParts([
    stringValue(location.street_address),
    stringValue(location.address_line_2),
  ]).join(", ");
  const locality = uniqueParts([
    stringValue(location.locality),
    stringValue(location.region),
    stringValue(location.postal_code),
  ]).join(", ");
  const address = uniqueParts([street || null, locality || null, stringValue(location.country)]);
  if (address.length > 0) return address.join("\n");
  return stringValue(location.name);
}

function affiliatedParent(
  response: Record<string, unknown>,
  parentId: string | null,
): Record<string, unknown> | null {
  if (!Array.isArray(response.affiliated_entities)) return null;
  const entities = response.affiliated_entities
    .map(objectValue)
    .filter((value): value is Record<string, unknown> => Boolean(value));
  if (parentId) {
    const exact = entities.find((entity) => stringValue(entity.affiliated_id) === parentId);
    if (exact) return exact;
  }
  return (
    entities.find((entity) => stringValue(entity.relationship) === "immediate_parent") ??
    entities.find((entity) => stringValue(entity.relationship) === "ultimate_parent") ??
    null
  );
}

function normalizeParent(response: Record<string, unknown>): CompanyFirmographicParent | null {
  const immediate = objectValue(response.immediate_parent);
  const ultimate = objectValue(response.ultimate_parent);
  const parentObject = immediate ?? ultimate;
  const parentId =
    stringValue(response.immediate_parent) ??
    stringValue(immediate?.id) ??
    stringValue(immediate?.affiliated_id) ??
    stringValue(response.ultimate_parent) ??
    stringValue(ultimate?.id) ??
    stringValue(ultimate?.affiliated_id);
  const affiliate = affiliatedParent(response, parentId);
  const name =
    stringValue(parentObject?.display_name) ??
    stringValue(parentObject?.name) ??
    stringValue(affiliate?.display_name) ??
    stringValue(affiliate?.name);
  const website =
    stringValue(parentObject?.website) ??
    stringValue(parentObject?.domain) ??
    stringValue(affiliate?.website) ??
    stringValue(affiliate?.domain);
  const domain = normalizeDomain(website);
  if (!parentId && !name && !domain) return null;
  return { providerRecordId: parentId, name, domain };
}

function normalizeCompanyProfile(value: unknown): CompanyFirmographicProfile {
  const response = objectValue(value);
  if (!response) throw new Error("People Data Labs returned an invalid company profile");
  const providerRecordId = stringValue(response.id);
  if (!providerRecordId) {
    throw new Error("People Data Labs returned a company profile without an ID");
  }
  const website = stringValue(response.website);
  const likelihood =
    typeof response.likelihood === "number" && Number.isFinite(response.likelihood)
      ? response.likelihood
      : 7;
  return {
    providerRecordId,
    name: stringValue(response.display_name) ?? stringValue(response.name),
    domain: normalizeDomain(website),
    websiteUrl: normalizeWebsite(website),
    industry: stringValue(response.industry_v2) ?? stringValue(response.industry),
    employeeCount: integerValue(response.employee_count),
    headquartersAddress: formatHeadquarters(response.location),
    parentCompany: normalizeParent(response),
    confidence: Math.min(Math.max(Math.round(likelihood * 10), 0), 100),
    observedAt: new Date().toISOString(),
  };
}

function errorMessage(parsed: unknown, status: number, statusText: string): string {
  const body = objectValue(parsed);
  const error = objectValue(body?.error);
  return (
    stringValue(error?.message) ??
    stringValue(body?.message) ??
    stringValue(body?.detail) ??
    `People Data Labs ${status} ${statusText}`.trim()
  );
}

async function companyLookup(
  apiKey: string,
  input: CompanyFirmographicLookupInput,
): Promise<CompanyFirmographicProfile | null> {
  const providerRecordId = input.providerRecordId?.trim();
  const name = input.name?.trim();
  const website = input.website?.trim() || input.domain?.trim();
  const location = input.location?.trim();
  if (!providerRecordId && !name && !website) {
    throw new Error("Provide a company name, domain, website, or provider record ID");
  }

  const url = new URL(PDL_COMPANY_ENRICH_URL);
  if (providerRecordId) {
    url.searchParams.set("pdl_id", providerRecordId);
  } else {
    if (name) url.searchParams.set("name", name);
    if (website) url.searchParams.set("website", website);
    if (location) url.searchParams.set("location", location);
  }
  url.searchParams.set("min_likelihood", "6");
  url.searchParams.set("titlecase", "true");
  url.searchParams.set("data_include", PDL_DATA_INCLUDE);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Api-Key": apiKey,
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  // PDL documents 404 as a successful, uncharged no-match result.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(errorMessage(parsed, response.status, response.statusText));
  }
  return normalizeCompanyProfile(parsed);
}

async function validateApiKey(apiKey: string): Promise<void> {
  // `.invalid` is a reserved non-resolving suffix. A 404 proves the API
  // authenticated the request without consuming a billable company match.
  await companyLookup(apiKey, { website: PDL_VALIDATION_WEBSITE });
}

function configFromContext(ctx: IntegrationRuntimeContext): PeopleDataLabsConfig {
  const apiKey = stringValue(ctx.config.apiKey);
  if (!apiKey) throw new Error("People Data Labs API key is missing");
  return { apiKey };
}

export const peopleDataLabsProvider: IntegrationProvider = {
  catalog: {
    provider: "people-data-labs",
    name: "People Data Labs",
    category: "Analytics",
    tagline: "Company firmographics from a bring-your-own API key.",
    description:
      "Enrich Revenue Accounts with reviewable company domain, employee count, industry, headquarters, and corporate-parent evidence. People Data Labs charges for successful matches; Genosyn caches results and never auto-applies them.",
    icon: "Building2",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "People Data Labs API key",
        required: true,
        hint: "The key is encrypted with this Connection. Successful company matches may consume PDL credits.",
      },
    ],
    enabled: true,
  },

  // Billable lookups are deliberately not exposed as generic Integration
  // tools. Revenue owns the preview/cache/confirmation workflow so an AI
  // Employee cannot consume provider credits with a direct Connection call.
  tools: [],

  lookupCompanyFirmographics(input, ctx) {
    return companyLookup(configFromContext(ctx).apiKey, input);
  },

  async validateApiKey(input) {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new Error("API key is required");
    await validateApiKey(apiKey);
    return {
      config: { apiKey },
      accountHint: maskSecret(apiKey),
    };
  },

  async checkStatus(ctx) {
    try {
      await validateApiKey(configFromContext(ctx).apiKey);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async invokeTool(name, _args, _ctx) {
    throw new Error(
      `Unknown People Data Labs tool: ${name}. Use the confirmed Revenue firmographics workflow.`,
    );
  },
};
