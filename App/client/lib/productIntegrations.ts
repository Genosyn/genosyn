import type { SectionKey } from "./sections";

/**
 * Product-scoped views over the company Integration catalog.
 *
 * `providers: null` is deliberate: these products can invoke any Integration
 * the company connects, so their useful subset is the complete catalog.
 * Every other product names only the providers that feed that product's
 * native workflow or are a natural external counterpart to it.
 */
export type ProductIntegrationKey =
  | "workspace"
  | "mail"
  | "employees"
  | "skills"
  | "routines"
  | "tasks"
  | "bases"
  | "notes"
  | "resources"
  | "explore"
  | "code"
  | "pipelines"
  | "revenue"
  | "customers"
  | "finance";

export type ProductIntegrationScope = {
  label: string;
  description: string;
  providers: readonly string[] | null;
};

export const PRODUCT_INTEGRATION_SCOPES: Record<ProductIntegrationKey, ProductIntegrationScope> = {
  workspace: {
    label: "Workspace",
    description:
      "Connect the communication and collaboration services your team uses alongside Workspace.",
    providers: ["google", "telegram", "reddit", "linkedin", "x", "nostr"],
  },
  mail: {
    label: "Email",
    description: "Email uses a Google Workspace Connection authorized with the Gmail product.",
    providers: ["google"],
  },
  employees: {
    label: "AI Employees",
    description: "AI Employees can use any company Connection once you give them a Grant.",
    providers: null,
  },
  skills: {
    label: "Skills",
    description:
      "A Skill can teach an AI Employee to use any Integration the employee has been granted.",
    providers: null,
  },
  routines: {
    label: "Routines",
    description: "A Routine can use any Integration granted to the AI Employee who owns it.",
    providers: null,
  },
  tasks: {
    label: "Tasks",
    description:
      "Connect external work tracking so AI Employees can coordinate Tasks with the tools your team already uses.",
    providers: ["linear"],
  },
  bases: {
    label: "Bases",
    description:
      "Connect external no-code databases that AI Employees can use alongside native Bases.",
    providers: ["airtable", "nocodb"],
  },
  notes: {
    label: "Notes",
    description: "Connect external documents and knowledge sources that complement native Notes.",
    providers: ["notion", "google"],
  },
  resources: {
    label: "Resources",
    description:
      "Connect document systems that AI Employees can use alongside the Resources library.",
    providers: ["notion", "google"],
  },
  explore: {
    label: "Explore",
    description:
      "Explore runs saved SQL Charts and Dashboards against Postgres, MySQL, and ClickHouse Connections.",
    providers: ["postgres", "mysql", "clickhouse"],
  },
  code: {
    label: "Code",
    description:
      "Connect GitHub to import allowlisted repositories and let granted AI Employees collaborate on code.",
    providers: ["github"],
  },
  pipelines: {
    label: "Pipelines",
    description:
      "Pipelines can call actions from any connected Integration as predictable automation steps.",
    providers: null,
  },
  revenue: {
    label: "Revenue",
    description:
      "Connect mail, product data, payments, analytics, and acquisition channels used by Revenue workflows.",
    providers: [
      "google",
      "postgres",
      "mysql",
      "clickhouse",
      "stripe",
      "google-analytics",
      "google-search-console",
      "google-ads",
      "meta-ads",
      "microsoft-ads",
      "reddit-ads",
      "reddit",
      "linkedin",
      "x",
    ],
  },
  customers: {
    label: "Customers",
    description:
      "Connect Stripe to look up the billing activity associated with your customer relationships.",
    providers: ["stripe"],
  },
  finance: {
    label: "Finance",
    description:
      "Connect payment and banking services used for reconciliation, card expenses, and finance work.",
    providers: ["stripe", "brex", "lightning", "lightning-lnd"],
  },
};

export const PRODUCT_INTEGRATION_KEYS = Object.keys(
  PRODUCT_INTEGRATION_SCOPES,
) as ProductIntegrationKey[];

export function productIntegrationScope(section: SectionKey): ProductIntegrationScope | null {
  return section in PRODUCT_INTEGRATION_SCOPES
    ? PRODUCT_INTEGRATION_SCOPES[section as ProductIntegrationKey]
    : null;
}
