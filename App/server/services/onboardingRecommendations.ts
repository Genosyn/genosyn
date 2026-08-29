import { DataSource } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import type { Company } from "../db/entities/Company.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Routine } from "../db/entities/Routine.js";
import { listCatalog } from "../integrations/index.js";
import type { IntegrationCatalogEntry } from "../integrations/types.js";
import { toSlug } from "../lib/slug.js";
import { nextRunFor } from "./cron.js";
import { assertRoutineCapacity } from "./entitlements.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * Fast, deterministic recommendations for the post-hire onboarding moment.
 *
 * This deliberately does not call an AI Model: onboarding commonly happens
 * before the employee has a connected model, and a static, scored catalogue
 * gives the UI a useful answer immediately. Role/template matches supply the
 * job-specific prior; Company mission and vision keywords move the ranking
 * toward the outcomes the business actually named.
 */

export type OnboardingRecommendationContext = {
  companyName: string;
  mission: string;
  vision: string;
  employeeName: string;
  employeeRole: string;
};

export type RoutineRecommendationStatus = "suggested" | "ready";

export type OnboardingRoutineRecommendation = {
  id: string;
  name: string;
  summary: string;
  cronExpr: string;
  body: string;
  reasons: string[];
  status: RoutineRecommendationStatus;
  routineId: string | null;
};

export type IntegrationRecommendationStatus =
  | "ready"
  | "grant_needed"
  | "connection_attention"
  | "connect_needed";

export type OnboardingIntegrationRecommendation = IntegrationCatalogEntry & {
  reason: string;
  status: IntegrationRecommendationStatus;
  connections: Array<{
    id: string;
    label: string;
    status: IntegrationConnection["status"];
    granted: boolean;
  }>;
};

export type OnboardingRecommendations = {
  context: OnboardingRecommendationContext;
  routines: OnboardingRoutineRecommendation[];
  integrations: OnboardingIntegrationRecommendation[];
};

export type CompanyRecommendationProfile = Pick<Company, "id" | "name"> & {
  mission?: string | null;
  vision?: string | null;
};

type RoutineRecommendationDefinition = {
  id: string;
  family: string;
  name: string;
  aliases?: readonly string[];
  summary: string;
  cronExpr: string;
  goal: string;
  inputs: readonly string[];
  outputs: readonly string[];
  guardrails: readonly string[];
  templateIds: readonly string[];
  rolePhrases: readonly string[];
  contextKeywords: readonly string[];
  integrationProviders: readonly string[];
  baseScore?: number;
};

/**
 * Stable ids are part of the POST contract. Rename display copy freely, but
 * never recycle or silently change an id to mean a different Routine.
 */
export const ROUTINE_RECOMMENDATION_DEFINITIONS: readonly RoutineRecommendationDefinition[] = [
  {
    id: "daily-executive-brief",
    family: "leadership-planning",
    name: "Daily brief",
    summary: "Start each weekday with the schedule, decisions, and risks that need attention.",
    cronExpr: "0 7 * * 1-5",
    goal: "Give leadership a concise, decision-first view of the day before work begins.",
    inputs: [
      "Today's calendar and deadlines",
      "Open decisions and follow-ups",
      "New urgent signals",
    ],
    outputs: [
      "A brief under 200 words",
      "The two or three decisions that need a human",
      "Named risks with a next step",
    ],
    guardrails: [
      "Do not send messages or change the calendar without approval",
      "State when an input is missing or stale",
    ],
    templateIds: ["executive-assistant"],
    rolePhrases: ["executive assistant", "chief of staff", "personal assistant", "administrator"],
    contextKeywords: ["leadership", "focus", "calendar", "decision", "executive", "productivity"],
    integrationProviders: ["google", "notion"],
  },
  {
    id: "weekly-look-ahead",
    family: "leadership-planning",
    name: "Weekly look-ahead",
    summary: "Prepare next week before it starts, including meetings, deadlines, and conflicts.",
    cronExpr: "0 16 * * 5",
    goal: "End the week with the next one prepared and no avoidable Monday surprises.",
    inputs: ["Next week's calendar", "Open work and deadlines", "Meeting preparation still owed"],
    outputs: [
      "A one-page week-ahead brief",
      "Conflicts and preparation gaps",
      "Questions that need answers before Monday",
    ],
    guardrails: [
      "Propose calendar changes rather than making them",
      "Keep low-priority detail out of the brief",
    ],
    templateIds: ["executive-assistant", "operations"],
    rolePhrases: ["executive assistant", "operations", "chief of staff", "project coordinator"],
    contextKeywords: ["planning", "operations", "delivery", "deadline", "coordination"],
    integrationProviders: ["google", "linear", "notion"],
  },
  {
    id: "daily-customer-health",
    family: "customer-health",
    name: "Daily churn digest",
    summary: "Surface customer risk, stalled adoption, and the safest next action every weekday.",
    cronExpr: "0 8 * * 1-5",
    goal: "Focus the team on the small set of customer relationships that need attention today.",
    inputs: [
      "Recent customer activity and conversations",
      "Open support work",
      "Renewal and usage signals",
    ],
    outputs: [
      "A ranked customer-risk digest",
      "Evidence for every risk rating",
      "A draft next action for review",
    ],
    guardrails: [
      "Never invent usage or sentiment",
      "Draft outreach but do not send it",
      "Do not promise discounts, refunds, or service levels",
    ],
    templateIds: ["customer-success", "support"],
    rolePhrases: ["customer success", "account manager", "customer support", "support specialist"],
    contextKeywords: [
      "customer",
      "retention",
      "churn",
      "renewal",
      "adoption",
      "support",
      "satisfaction",
    ],
    integrationProviders: ["google", "stripe", "postgres"],
  },
  {
    id: "weekly-deal-hygiene",
    family: "revenue-operations",
    name: "Weekly deal hygiene",
    aliases: ["Weekly pipeline hygiene"],
    summary: "Find stale Deals, missing next steps, and dates that no longer look credible.",
    cronExpr: "0 8 * * 1",
    goal: "Keep the Deal Stage view trustworthy enough for the team to act on it.",
    inputs: [
      "Open Deals and their recent Activities",
      "Expected close dates",
      "Owners and next steps",
    ],
    outputs: [
      "A review list ordered by urgency",
      "The exact field or follow-up that needs attention",
      "A short revenue-risk summary",
    ],
    guardrails: [
      "Do not move a Deal Stage or change a forecast without approval",
      "Use evidence from recorded Activities",
    ],
    templateIds: ["sdr", "revops-analyst", "account-executive"],
    rolePhrases: [
      "sales development",
      "sdr",
      "revops",
      "revenue operations",
      "account executive",
      "sales manager",
    ],
    contextKeywords: ["sales", "revenue", "deal", "growth", "conversion", "forecast"],
    integrationProviders: ["google", "stripe"],
  },
  {
    id: "monthly-revenue-report",
    family: "revenue-reporting",
    name: "Monthly revenue report",
    summary: "Give leadership a monthly view of revenue movement, conversion, and risk.",
    cronExpr: "0 9 1 * *",
    goal: "Explain what changed in revenue performance and which question deserves investigation next.",
    inputs: [
      "Deals and Deal Stages",
      "Won and lost revenue",
      "Recent acquisition and customer signals",
    ],
    outputs: [
      "A concise monthly report",
      "Changes from the prior month",
      "One evidence-backed recommendation",
    ],
    guardrails: ["Label estimates and missing data", "Do not present correlation as causation"],
    templateIds: ["revops-analyst", "account-executive", "data-analyst"],
    rolePhrases: [
      "revops",
      "revenue operations",
      "finance analyst",
      "data analyst",
      "sales operations",
    ],
    contextKeywords: ["revenue", "growth", "forecast", "conversion", "margin", "profit"],
    integrationProviders: ["stripe", "postgres", "google-analytics"],
  },
  {
    id: "daily-deal-check",
    family: "deal-momentum",
    name: "Daily deal check",
    summary: "Start the day with the Deals that need a decision, follow-up, or unblock.",
    cronExpr: "0 8 * * 1-5",
    goal: "Protect momentum on active Deals by making the next useful action obvious.",
    inputs: ["Open Deals", "Recent Activities and replies", "Next steps and follow-up dates"],
    outputs: [
      "A short priority list",
      "A recommended next action per Deal",
      "Reviewable follow-up drafts where useful",
    ],
    guardrails: [
      "Never send outreach automatically",
      "Never invent a Contact detail or customer commitment",
    ],
    templateIds: ["account-executive", "sdr"],
    rolePhrases: [
      "account executive",
      "sales development",
      "sdr",
      "sales representative",
      "business development",
    ],
    contextKeywords: ["deal", "sales", "revenue", "outbound", "prospect", "conversion"],
    integrationProviders: ["google", "linkedin"],
  },
  {
    id: "monday-status-digest",
    family: "operations-review",
    name: "Monday status digest",
    summary: "Turn active work, blockers, and overdue follow-ups into one weekly operating view.",
    cronExpr: "0 9 * * 1",
    goal: "Give the team a reliable start-of-week view of commitments, blockers, and owners.",
    inputs: ["Active Projects and Tasks", "Open follow-ups", "Known deadlines and blockers"],
    outputs: [
      "A status digest grouped by outcome",
      "Every blocker with an owner",
      "The three priorities for the week",
    ],
    guardrails: [
      "Do not mark work complete without evidence",
      "Separate confirmed facts from assumptions",
    ],
    templateIds: ["operations", "product-manager"],
    rolePhrases: [
      "operations",
      "project manager",
      "project coordinator",
      "program manager",
      "product manager",
    ],
    contextKeywords: [
      "operations",
      "delivery",
      "execution",
      "project",
      "efficiency",
      "coordination",
    ],
    integrationProviders: ["linear", "notion", "google"],
  },
  {
    id: "daily-ad-pacing",
    family: "paid-marketing",
    name: "Daily pacing check",
    summary: "Catch budget pacing, tracking, and performance anomalies before they compound.",
    cronExpr: "0 9 * * *",
    goal: "Spot paid-media risks early while keeping every spend change under human control.",
    inputs: ["Channel spend and budget", "Conversions and attributed value", "Tracking health"],
    outputs: [
      "A channel-by-channel pacing summary",
      "Anomalies with supporting numbers",
      "Proposed actions for review",
    ],
    guardrails: [
      "Never change spend automatically",
      "Call out attribution or tracking uncertainty",
    ],
    templateIds: ["paid-marketing", "marketing"],
    rolePhrases: ["performance marketer", "paid marketing", "growth marketer", "media buyer"],
    contextKeywords: [
      "advertising",
      "acquisition",
      "roas",
      "campaign",
      "paid",
      "growth",
      "conversion",
    ],
    integrationProviders: ["google-ads", "meta-ads", "google-analytics"],
  },
  {
    id: "weekly-ad-spend-report",
    family: "marketing-reporting",
    name: "Weekly spend report",
    summary: "Explain how paid-media spend translated into results over the last week.",
    cronExpr: "0 9 * * 1",
    goal: "Give the team a clear weekly read on spend, outcomes, and the next experiment.",
    inputs: ["Spend by channel and campaign", "Conversions and value", "Prior-week comparison"],
    outputs: [
      "A weekly performance report",
      "Material changes with likely explanations",
      "One reviewable experiment",
    ],
    guardrails: [
      "Do not hide missing attribution",
      "Do not recommend spend increases without evidence",
    ],
    templateIds: ["paid-marketing", "marketing", "data-analyst"],
    rolePhrases: [
      "performance marketer",
      "marketing manager",
      "growth marketer",
      "marketing analyst",
    ],
    contextKeywords: ["marketing", "campaign", "acquisition", "advertising", "growth", "brand"],
    integrationProviders: ["google-analytics", "google-ads", "meta-ads"],
  },
  {
    id: "daily-campaign-optimization",
    family: "paid-marketing",
    name: "Daily Campaign optimization",
    summary: "Review campaign performance and prepare bounded optimization proposals.",
    cronExpr: "30 9 * * *",
    goal: "Turn current campaign evidence into small, reviewable improvements.",
    inputs: ["Campaign and creative performance", "Budget and safety limits", "Recent experiments"],
    outputs: [
      "A ranked optimization proposal",
      "Expected upside and downside",
      "The evidence behind each change",
    ],
    guardrails: [
      "Never apply a spend or targeting change without approval",
      "Prefer reversible experiments",
    ],
    templateIds: ["paid-marketing"],
    rolePhrases: ["performance marketer", "media buyer", "paid marketing"],
    contextKeywords: ["campaign", "advertising", "optimization", "roas", "paid"],
    integrationProviders: ["google-ads", "meta-ads", "microsoft-ads"],
  },
  {
    id: "weekly-metrics-digest",
    family: "analytics",
    name: "Weekly metrics digest",
    summary: "Summarize the metrics that moved, why they may have moved, and what to inspect next.",
    cronExpr: "0 9 * * 1",
    goal: "Give the company a trustworthy 60-second weekly read on its core metrics.",
    inputs: [
      "The company's agreed metrics",
      "Current and comparison periods",
      "Known launches or incidents",
    ],
    outputs: [
      "A concise metric digest",
      "Material deltas with source links",
      "One question to investigate",
    ],
    guardrails: ["Say when a number cannot be trusted", "Separate measured facts from hypotheses"],
    templateIds: ["data-analyst", "research-analyst", "revops-analyst"],
    rolePhrases: ["data analyst", "analytics", "business intelligence", "research analyst"],
    contextKeywords: ["data", "metric", "analytics", "insight", "measurement", "evidence", "kpi"],
    integrationProviders: ["postgres", "clickhouse", "google-analytics"],
  },
  {
    id: "engineering-issue-triage",
    family: "engineering",
    name: "Engineering issue triage",
    summary: "Review new engineering work, regressions, and blocked changes each weekday.",
    cronExpr: "0 9 * * 1-5",
    goal: "Keep engineering attention on reproducible, high-impact work with a clear owner.",
    inputs: [
      "New and changed issues",
      "Open pull requests and checks",
      "Recent incidents or customer reports",
    ],
    outputs: [
      "A prioritized triage list",
      "Reproduction or evidence gaps",
      "Suggested owners and next steps",
    ],
    guardrails: [
      "Do not merge or deploy automatically",
      "Never label a bug fixed without verification",
    ],
    templateIds: ["engineer", "product-manager"],
    rolePhrases: [
      "software engineer",
      "developer",
      "engineering manager",
      "devops",
      "site reliability",
    ],
    contextKeywords: [
      "software",
      "engineering",
      "developer",
      "reliability",
      "platform",
      "product",
      "code",
    ],
    integrationProviders: ["github", "linear"],
  },
  {
    id: "competitive-research-scan",
    family: "research",
    name: "Competitive research scan",
    summary: "Collect material market and competitor changes into a sourced weekly brief.",
    cronExpr: "0 10 * * 2",
    goal: "Keep strategy grounded in current, verifiable external evidence.",
    inputs: [
      "Named competitors and market questions",
      "Trusted public sources",
      "Prior findings that need updating",
    ],
    outputs: [
      "A short sourced research brief",
      "What changed since the last scan",
      "Implications clearly separated from facts",
    ],
    guardrails: [
      "Cite every material claim",
      "Do not invent facts or treat marketing copy as independent evidence",
    ],
    templateIds: ["research-analyst", "product-manager"],
    rolePhrases: [
      "research analyst",
      "market researcher",
      "strategy analyst",
      "competitive intelligence",
    ],
    contextKeywords: ["research", "market", "competitor", "strategy", "evidence", "innovation"],
    integrationProviders: ["notion", "google-search-console"],
  },
  {
    id: "content-opportunity-scan",
    family: "content",
    name: "Content opportunity scan",
    summary: "Turn search, audience, and product signals into a focused weekly content brief.",
    cronExpr: "0 10 * * 1",
    goal: "Choose the next useful content from audience evidence instead of a blank page.",
    inputs: [
      "Search and website performance",
      "Customer questions",
      "Current product and campaign priorities",
    ],
    outputs: [
      "Three ranked content opportunities",
      "Audience intent and evidence",
      "A reviewable brief for the top choice",
    ],
    guardrails: ["Do not publish automatically", "Avoid claims the source material cannot support"],
    templateIds: ["content-writer", "marketing"],
    rolePhrases: ["content writer", "copywriter", "content marketer", "marketing manager", "seo"],
    contextKeywords: ["content", "audience", "brand", "search", "seo", "marketing", "education"],
    integrationProviders: ["google-search-console", "google-analytics", "notion"],
  },
  {
    id: "support-inbox-triage",
    family: "support",
    name: "Support inbox triage",
    summary: "Group new customer requests by urgency and prepare safe, reviewable replies.",
    cronExpr: "0 8 * * 1-5",
    goal: "Make urgent support work visible and reduce response time without sacrificing accuracy.",
    inputs: ["Unread support conversations", "Customer and product context", "Escalation guidance"],
    outputs: [
      "Urgent, needs-reply, and informational groups",
      "Draft replies for review",
      "Escalations with a concise reason",
    ],
    guardrails: [
      "Never send automatically",
      "Do not promise refunds, service levels, or fixes",
      "Protect customer data",
    ],
    templateIds: ["support", "customer-success", "executive-assistant"],
    rolePhrases: ["customer support", "support specialist", "service desk", "executive assistant"],
    contextKeywords: ["support", "customer", "response", "service", "satisfaction", "inbox"],
    integrationProviders: ["google", "linear", "notion"],
  },
  {
    id: "product-feedback-digest",
    family: "product",
    name: "Product feedback digest",
    summary: "Synthesize customer feedback into evidence-backed themes and product questions.",
    cronExpr: "0 11 * * 5",
    goal: "Help product decisions start from recurring customer evidence rather than the loudest anecdote.",
    inputs: [
      "Customer feedback and support themes",
      "Recent product changes",
      "Open product questions",
    ],
    outputs: [
      "A weekly theme digest",
      "Representative evidence for each theme",
      "Questions or experiments to review",
    ],
    guardrails: [
      "Do not manufacture consensus",
      "Preserve the distinction between requests and underlying problems",
    ],
    templateIds: ["product-manager", "customer-success", "support"],
    rolePhrases: ["product manager", "product owner", "customer success", "user researcher"],
    contextKeywords: ["product", "feedback", "customer", "experience", "innovation", "adoption"],
    integrationProviders: ["linear", "notion", "google"],
  },
  {
    id: "daily-priority-check",
    family: "general-priorities",
    name: "Daily priority check",
    summary: "Translate the AI Employee's role and company priorities into a short daily plan.",
    cronExpr: "0 9 * * 1-5",
    goal: "Start each workday with the highest-value outcomes and the context needed to move them.",
    inputs: [
      "The employee's Soul and role",
      "Company mission and vision",
      "Open work, deadlines, and blockers",
    ],
    outputs: [
      "The three outcomes that matter today",
      "Needed inputs or approvals",
      "Work that is blocked or at risk",
    ],
    guardrails: [
      "Do not create busywork to fill the list",
      "Ask when company context is too thin to prioritize safely",
    ],
    templateIds: [],
    rolePhrases: [],
    contextKeywords: [],
    integrationProviders: ["notion", "linear"],
    baseScore: 12,
  },
  {
    id: "weekly-outcome-review",
    family: "general-review",
    name: "Weekly outcome review",
    summary:
      "Close the week with completed outcomes, open risks, and a concrete next-week recommendation.",
    cronExpr: "0 15 * * 5",
    goal: "Create a reliable learning loop between the company's priorities and the employee's recurring work.",
    inputs: [
      "Work completed this week",
      "Missed or changed commitments",
      "Company mission and vision",
    ],
    outputs: [
      "Outcomes and evidence",
      "What did not work and why",
      "A proposed focus for next week",
    ],
    guardrails: ["Report misses plainly", "Do not claim impact without evidence"],
    templateIds: [],
    rolePhrases: [],
    contextKeywords: [],
    integrationProviders: ["notion", "google"],
    baseScore: 11,
  },
  {
    id: "monthly-mission-check",
    family: "general-strategy",
    name: "Monthly mission check",
    summary:
      "Review whether recurring work is still moving the company toward its stated mission and vision.",
    cronExpr: "0 10 1 * *",
    goal: "Keep autonomous work aligned as the company learns and priorities change.",
    inputs: [
      "Company mission and vision",
      "The last month's outcomes",
      "Current Routines and open priorities",
    ],
    outputs: [
      "Evidence of progress or drift",
      "Routines that may need adjustment",
      "Three questions for leadership",
    ],
    guardrails: [
      "Do not rewrite the mission or vision",
      "Treat missing outcome data as a gap, not success",
    ],
    templateIds: [],
    rolePhrases: [],
    contextKeywords: ["mission", "vision", "impact", "purpose", "strategy"],
    integrationProviders: ["notion", "google"],
    baseScore: 8,
  },
] as const;

type IntegrationAffinity = {
  providers: readonly string[];
  templateIds: readonly string[];
  rolePhrases: readonly string[];
  contextKeywords: readonly string[];
  reason: string;
};

const INTEGRATION_AFFINITIES: readonly IntegrationAffinity[] = [
  {
    providers: ["google", "notion"],
    templateIds: ["executive-assistant", "operations"],
    rolePhrases: ["executive assistant", "chief of staff", "operations", "administrator"],
    contextKeywords: ["calendar", "inbox", "document", "meeting", "operations"],
    reason: "Bring day-to-day communication and company context into recurring work.",
  },
  {
    providers: ["google", "linkedin", "stripe"],
    templateIds: ["sdr", "revops-analyst", "account-executive"],
    rolePhrases: ["sales", "sdr", "revops", "revenue", "account executive", "business development"],
    contextKeywords: ["sales", "revenue", "prospect", "deal", "growth", "customer"],
    reason: "Give revenue work verified Contact, conversation, and commercial context.",
  },
  {
    providers: ["google", "stripe", "postgres"],
    templateIds: ["customer-success", "support"],
    rolePhrases: ["customer success", "customer support", "support specialist", "account manager"],
    contextKeywords: ["customer", "retention", "support", "churn", "renewal", "adoption"],
    reason:
      "Combine customer conversations with billing or product signals for better prioritization.",
  },
  {
    providers: ["github", "linear"],
    templateIds: ["engineer", "product-manager"],
    rolePhrases: ["engineer", "developer", "product manager", "devops", "software"],
    contextKeywords: ["engineering", "software", "code", "product", "reliability", "developer"],
    reason:
      "Connect the source and work-tracking systems where product and engineering decisions happen.",
  },
  {
    providers: ["google-analytics", "google-search-console", "google-ads", "meta-ads", "linkedin"],
    templateIds: ["content-writer", "marketing", "paid-marketing"],
    rolePhrases: ["marketing", "content", "copywriter", "seo", "media buyer"],
    contextKeywords: [
      "marketing",
      "content",
      "audience",
      "campaign",
      "acquisition",
      "brand",
      "advertising",
    ],
    reason: "Use current audience and campaign evidence instead of planning from assumptions.",
  },
  {
    providers: ["postgres", "clickhouse", "mysql", "google-analytics", "notion"],
    templateIds: ["data-analyst", "research-analyst"],
    rolePhrases: ["data analyst", "analytics", "research analyst", "business intelligence"],
    contextKeywords: ["data", "metric", "analytics", "research", "evidence", "insight"],
    reason: "Give analytical work direct access to evidence and a place to share findings.",
  },
];

const INTEGRATION_FALLBACK_ORDER = ["google", "notion", "linear"] as const;
const MAX_ROUTINE_RESULTS = 4;
const MAX_INTEGRATION_RESULTS = 3;

function compactContext(value: string | null | undefined, max = 2_000): string {
  return (value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

function markdownQuote(label: string, value: string, fallback: string): string {
  const lines = compactContext(value, 1_200)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return `> **${label}:** ${fallback}`;
  return lines
    .map((line, index) => (index === 0 ? `> **${label}:** ${line}` : `> ${line}`))
    .join("\n");
}

export function recommendationContext(
  company: CompanyRecommendationProfile,
  employee: Pick<AIEmployee, "name" | "role">,
): OnboardingRecommendationContext {
  return {
    companyName: compactContext(company.name, 200),
    mission: compactContext(company.mission),
    vision: compactContext(company.vision),
    employeeName: compactContext(employee.name, 200),
    employeeRole: compactContext(employee.role, 200),
  };
}

export function buildRoutineRecommendationBody(
  definition: RoutineRecommendationDefinition,
  context: OnboardingRecommendationContext,
): string {
  const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  return `# ${definition.name}

**Schedule:** \`${definition.cronExpr}\`

## Goal
${definition.goal}

## Company context
${markdownQuote("Company", context.companyName, "Not set yet")}
${markdownQuote("Mission", context.mission, "Not set yet")}
${markdownQuote("Vision", context.vision, "Not set yet")}
${markdownQuote("AI Employee", `${context.employeeName} — ${context.employeeRole}`, "Not set yet")}

Use this context to prioritize the work. If it is missing or conflicts with current company
direction, ask a Member before making a consequential assumption.

## Inputs
${bullets(definition.inputs)}

## Output
${bullets(definition.outputs)}

## Guardrails
${bullets(definition.guardrails)}
`;
}

type RankedRoutine = {
  definition: RoutineRecommendationDefinition;
  score: number;
  reasons: string[];
  order: number;
};

function rankRoutineDefinitions(args: {
  context: OnboardingRecommendationContext;
  templateId?: string;
}): RankedRoutine[] {
  const role = normalize(args.context.employeeRole);
  const companyContext = normalize(`${args.context.mission} ${args.context.vision}`);
  return ROUTINE_RECOMMENDATION_DEFINITIONS.map((definition, order) => {
    let score = definition.baseScore ?? 0;
    const reasons: string[] = [];

    if (args.templateId && definition.templateIds.includes(args.templateId)) {
      score += 100;
      reasons.push("Fits the starting role selected during hiring.");
    }

    const roleMatches = definition.rolePhrases.filter((phrase) => containsPhrase(role, phrase));
    if (roleMatches.length > 0) {
      score += Math.min(70, 35 + (roleMatches.length - 1) * 12);
      reasons.push(`Matches ${args.context.employeeRole}'s responsibilities.`);
    }

    const contextMatches = definition.contextKeywords.filter((keyword) =>
      containsPhrase(companyContext, keyword),
    );
    if (contextMatches.length > 0) {
      score += Math.min(48, contextMatches.length * 12);
      reasons.push(
        `Supports company priorities around ${contextMatches.slice(0, 2).join(" and ")}.`,
      );
    }

    if (reasons.length === 0) reasons.push("A useful starting rhythm for a new AI Employee.");
    return { definition, score, reasons, order };
  }).sort((a, b) => b.score - a.score || a.order - b.order);
}

function findMatchingRoutine(
  definition: RoutineRecommendationDefinition,
  routines: readonly Routine[],
): Routine | null {
  const names = [definition.name, ...(definition.aliases ?? [])];
  const normalizedNames = new Set(names.map(normalize));
  const slugs = new Set(names.map(toSlug));
  return (
    routines.find(
      (routine) => normalizedNames.has(normalize(routine.name)) || slugs.has(routine.slug),
    ) ?? null
  );
}

function selectRoutineRecommendations(args: {
  context: OnboardingRecommendationContext;
  templateId?: string;
  existingRoutines: readonly Routine[];
}): Array<RankedRoutine & { existing: Routine | null }> {
  const ranked = rankRoutineDefinitions(args).map((item) => ({
    ...item,
    existing: findMatchingRoutine(item.definition, args.existingRoutines),
  }));

  // Template hiring may already have seeded one or more of these Routines.
  // Show every matching top result as ready, then use the remaining slots for
  // alternatives so the response reflects both immediate value and next steps.
  const selected: Array<RankedRoutine & { existing: Routine | null }> = ranked
    .filter((item) => item.existing !== null)
    .slice(0, MAX_ROUTINE_RESULTS);
  const usedIds = new Set(selected.map((item) => item.definition.id));
  const usedFamilies = new Set(selected.map((item) => item.definition.family));

  const suggested = ranked.filter((item) => !item.existing && !usedIds.has(item.definition.id));

  // Prefer different outcome families first; fill any remaining places in
  // score order if a highly specialized catalogue has fewer distinct ones.
  for (const item of suggested) {
    if (selected.length >= MAX_ROUTINE_RESULTS) break;
    if (usedFamilies.has(item.definition.family)) continue;
    selected.push(item);
    usedIds.add(item.definition.id);
    usedFamilies.add(item.definition.family);
  }
  for (const item of suggested) {
    if (selected.length >= MAX_ROUTINE_RESULTS) break;
    if (usedIds.has(item.definition.id)) continue;
    selected.push(item);
    usedIds.add(item.definition.id);
  }
  return selected;
}

function integrationStatus(args: {
  connections: readonly IntegrationConnection[];
  grantedIds: ReadonlySet<string>;
}): IntegrationRecommendationStatus {
  const healthy = args.connections.filter((connection) => connection.status === "connected");
  if (healthy.some((connection) => args.grantedIds.has(connection.id))) return "ready";
  if (healthy.length > 0) return "grant_needed";
  if (args.connections.length > 0) return "connection_attention";
  return "connect_needed";
}

function statusReason(
  status: IntegrationRecommendationStatus,
  employeeName: string,
  affinityReason: string,
): string {
  if (status === "ready") {
    return `${affinityReason} A healthy Connection is already granted to ${employeeName}.`;
  }
  if (status === "grant_needed") {
    return `${affinityReason} A healthy Company Connection is ready to grant to ${employeeName}.`;
  }
  if (status === "connection_attention") {
    return `${affinityReason} The existing Company Connection needs attention before it can help.`;
  }
  return affinityReason;
}

function selectIntegrationRecommendations(args: {
  companyId: string;
  employeeId: string;
  context: OnboardingRecommendationContext;
  templateId?: string;
  selectedRoutines: readonly (RankedRoutine & { existing: Routine | null })[];
  catalog: readonly IntegrationCatalogEntry[];
  connections: readonly IntegrationConnection[];
  grants: readonly EmployeeConnectionGrant[];
}): OnboardingIntegrationRecommendation[] {
  const role = normalize(args.context.employeeRole);
  const companyContext = normalize(`${args.context.mission} ${args.context.vision}`);
  const score = new Map<string, number>();
  const reason = new Map<string, string>();

  args.selectedRoutines.forEach((routine, routineIndex) => {
    routine.definition.integrationProviders.forEach((provider, providerIndex) => {
      score.set(provider, (score.get(provider) ?? 0) + 45 - routineIndex * 4 - providerIndex);
      if (!reason.has(provider)) {
        reason.set(provider, `Adds useful context for ${routine.definition.name}.`);
      }
    });
  });

  for (const affinity of INTEGRATION_AFFINITIES) {
    const templateMatch = !!args.templateId && affinity.templateIds.includes(args.templateId);
    const roleMatches = affinity.rolePhrases.filter((phrase) =>
      containsPhrase(role, phrase),
    ).length;
    const contextMatches = affinity.contextKeywords.filter((keyword) =>
      containsPhrase(companyContext, keyword),
    ).length;
    const affinityScore =
      (templateMatch ? 70 : 0) + Math.min(55, roleMatches * 28) + Math.min(36, contextMatches * 12);
    if (affinityScore === 0) continue;
    affinity.providers.forEach((provider, index) => {
      score.set(provider, (score.get(provider) ?? 0) + affinityScore - index);
      reason.set(provider, affinity.reason);
    });
  }

  INTEGRATION_FALLBACK_ORDER.forEach((provider, index) => {
    score.set(provider, (score.get(provider) ?? 0) + 10 - index);
    if (!reason.has(provider)) {
      reason.set(
        provider,
        "Connect the everyday context this AI Employee needs to do useful work.",
      );
    }
  });

  const companyConnections = args.connections.filter(
    (connection) => connection.companyId === args.companyId,
  );
  const companyConnectionIds = new Set(companyConnections.map((connection) => connection.id));
  const grantedIds = new Set(
    args.grants
      .filter(
        (grant) =>
          grant.employeeId === args.employeeId && companyConnectionIds.has(grant.connectionId),
      )
      .map((grant) => grant.connectionId),
  );

  const uniqueCatalog = new Map<string, { entry: IntegrationCatalogEntry; order: number }>();
  args.catalog.forEach((entry, order) => {
    if (entry.enabled && !uniqueCatalog.has(entry.provider)) {
      uniqueCatalog.set(entry.provider, { entry, order });
    }
  });

  return [...uniqueCatalog.values()]
    .map(({ entry, order }) => ({
      entry,
      order,
      score: score.get(entry.provider) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_INTEGRATION_RESULTS)
    .map(({ entry }) => {
      const providerConnections = companyConnections.filter(
        (connection) => connection.provider === entry.provider,
      );
      const status = integrationStatus({ connections: providerConnections, grantedIds });
      const affinityReason =
        reason.get(entry.provider) ??
        "Connect a source of company context this AI Employee can use in Routines.";
      return {
        ...entry,
        reason: statusReason(status, args.context.employeeName, affinityReason),
        status,
        connections: providerConnections.map((connection) => ({
          id: connection.id,
          label: connection.label,
          status: connection.status,
          granted: grantedIds.has(connection.id),
        })),
      };
    });
}

/** Pure seam used by the route and unit tests. */
export function recommendOnboarding(args: {
  company: CompanyRecommendationProfile;
  employee: Pick<AIEmployee, "id" | "name" | "role">;
  templateId?: string;
  existingRoutines: readonly Routine[];
  catalog: readonly IntegrationCatalogEntry[];
  connections: readonly IntegrationConnection[];
  grants: readonly EmployeeConnectionGrant[];
}): OnboardingRecommendations {
  const context = recommendationContext(args.company, args.employee);
  const selectedRoutines = selectRoutineRecommendations({
    context,
    templateId: args.templateId,
    existingRoutines: args.existingRoutines,
  });
  return {
    context,
    routines: selectedRoutines.map(({ definition, reasons, existing }) => ({
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      cronExpr: definition.cronExpr,
      body: buildRoutineRecommendationBody(definition, context),
      reasons: existing ? [...reasons, `${args.employee.name} already has this Routine.`] : reasons,
      status: existing ? "ready" : "suggested",
      routineId: existing?.id ?? null,
    })),
    integrations: selectIntegrationRecommendations({
      companyId: args.company.id,
      employeeId: args.employee.id,
      context,
      templateId: args.templateId,
      selectedRoutines,
      catalog: args.catalog,
      connections: args.connections,
      grants: args.grants,
    }),
  };
}

/** Load the company-scoped state and feed it through the pure scorer. */
export async function loadOnboardingRecommendations(args: {
  company: CompanyRecommendationProfile;
  employee: Pick<AIEmployee, "id" | "name" | "role">;
  templateId?: string;
}): Promise<OnboardingRecommendations> {
  const [existingRoutines, connections, grants] = await Promise.all([
    AppDataSource.getRepository(Routine).find({ where: { employeeId: args.employee.id } }),
    AppDataSource.getRepository(IntegrationConnection).find({
      where: { companyId: args.company.id },
      order: { createdAt: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeConnectionGrant).find({
      where: { employeeId: args.employee.id },
      order: { createdAt: "ASC" },
    }),
  ]);
  return recommendOnboarding({
    ...args,
    existingRoutines,
    connections,
    grants,
    catalog: listCatalog(),
  });
}

export function findRoutineRecommendationDefinition(
  id: string,
): RoutineRecommendationDefinition | null {
  return ROUTINE_RECOMMENDATION_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

export type AppliedRoutineRecommendation = Routine & { recommendationId: string };

export type ApplyRoutineRecommendationsResult = {
  created: AppliedRoutineRecommendation[];
  existing: Array<{ recommendationId: string; routineId: string }>;
};

function retryableTransactionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  const code = String(candidate?.code ?? candidate?.errno ?? "");
  const message = String(candidate?.message ?? "").toLowerCase();
  return (
    ["23505", "40001", "40P01", "SQLITE_BUSY", "SQLITE_CONSTRAINT", "2067"].includes(code) ||
    message.includes("unique constraint") ||
    message.includes("database is locked")
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const SQLITE_WRITE_RETRY_DEADLINE_MS = 5_000;

/**
 * better-sqlite3 deliberately reuses one QueryRunner for a DataSource. That
 * makes unrelated concurrent TypeORM transactions into nested savepoints: a
 * caller can receive success and then have its rows rolled back by somebody
 * else's outer transaction. Use a second TypeORM connection for this short,
 * user-facing mutation so SQLite supplies a real lock/isolation boundary.
 *
 * Tests use `:memory:`, which cannot be shared across connections. They stay
 * on the main source and fail closed if another transaction is already open.
 */
async function routineWriteSource(): Promise<DataSource> {
  if (AppDataSource.options.type === "postgres") return AppDataSource;
  const database = String((AppDataSource.options as { database?: string }).database ?? ":memory:");
  if (database === ":memory:") return AppDataSource;

  const source = new DataSource({
    type: "better-sqlite3",
    database,
    entities: [Routine, AuditEvent],
    synchronize: false,
    logging: false,
    fileMustExist: true,
    // A short native wait followed by asynchronous backoff lets the holder of
    // another Connection's write lock keep progressing on Node's event loop.
    timeout: 40,
  });
  await source.initialize();
  return source;
}

// Keep recommendation applies in one FIFO lane on SQLite. The dedicated
// connection above isolates this lane from every other app transaction; this
// queue also makes identical clicks deterministically idempotent.
let sqliteRoutineApplyTail: Promise<void> = Promise.resolve();

async function serializeSqliteRoutineApply<T>(operation: () => Promise<T>): Promise<T> {
  if (AppDataSource.options.type === "postgres") return operation();

  const previous = sqliteRoutineApplyTail;
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  sqliteRoutineApplyTail = tail;
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sqliteRoutineApplyTail === tail) sqliteRoutineApplyTail = Promise.resolve();
  }
}

/**
 * Add a reviewed set of recommendations atomically and idempotently.
 *
 * The client sends stable ids only. Bodies and schedules are rebuilt on the
 * server from current Company context, so a stale or modified browser cannot
 * smuggle a different Routine through this shortcut. An existing same-name or
 * same-slug Routine is returned untouched.
 */
export async function applyRoutineRecommendations(args: {
  company: CompanyRecommendationProfile;
  employee: Pick<AIEmployee, "id" | "name" | "role">;
  recommendationIds: readonly string[];
  actorUserId?: string | null;
}): Promise<ApplyRoutineRecommendationsResult> {
  const recommendationIds = [...new Set(args.recommendationIds)];
  const definitions = recommendationIds.map((id) => findRoutineRecommendationDefinition(id));
  if (definitions.some((definition) => definition === null)) {
    const invalid = recommendationIds.filter((id) => !findRoutineRecommendationDefinition(id));
    throw new Error(`Unknown Routine recommendation: ${invalid.join(", ")}`);
  }
  const resolved = definitions as RoutineRecommendationDefinition[];
  const context = recommendationContext(args.company, args.employee);

  // Plan limit (M56): only the routines this apply would actually CREATE
  // count — an already-existing match is idempotent and costs nothing. A
  // selection over capacity throws PlanLimitError for the route to map to 402.
  const preExisting = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: args.employee.id },
  });
  const creating = resolved.filter(
    (definition) => !findMatchingRoutine(definition, preExisting),
  ).length;
  if (creating > 0) await assertRoutineCapacity(args.company.id, creating);

  return serializeSqliteRoutineApply(async () => {
    const writeSource = await routineWriteSource();
    try {
      if (
        writeSource === AppDataSource &&
        AppDataSource.options.type !== "postgres" &&
        AppDataSource.createQueryRunner().isTransactionActive
      ) {
        throw new Error(
          "Cannot add onboarding Routines while another SQLite transaction is active",
        );
      }

      let result: ApplyRoutineRecommendationsResult | null = null;
      const retryStartedAt = Date.now();
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await writeSource.transaction(async (manager) => {
            const repo = manager.getRepository(Routine);
            const existingRows = await repo.find({ where: { employeeId: args.employee.id } });
            const created: AppliedRoutineRecommendation[] = [];
            const existing: ApplyRoutineRecommendationsResult["existing"] = [];

            for (const definition of resolved) {
              const matched = findMatchingRoutine(definition, existingRows);
              if (matched) {
                existing.push({ recommendationId: definition.id, routineId: matched.id });
                continue;
              }
              const row = repo.create({
                employeeId: args.employee.id,
                name: definition.name,
                slug: toSlug(definition.name),
                cronExpr: definition.cronExpr,
                enabled: true,
                lastRunAt: null,
                nextRunAt: nextRunFor(definition.cronExpr),
                body: buildRoutineRecommendationBody(definition, context),
              });
              const saved = await repo.save(row);
              existingRows.push(saved);
              created.push(Object.assign(saved, { recommendationId: definition.id }));
            }

            if (created.length > 0) {
              const auditRepo = manager.getRepository(AuditEvent);
              await auditRepo.save(
                created.map((routine) =>
                  auditRepo.create({
                    companyId: args.company.id,
                    actorKind: args.actorUserId ? "user" : "system",
                    actorUserId: args.actorUserId ?? null,
                    actorEmployeeId: null,
                    action: "routine.create",
                    targetType: "routine",
                    targetId: routine.id,
                    targetLabel: routine.name,
                    metadataJson: JSON.stringify({
                      employeeId: args.employee.id,
                      cronExpr: routine.cronExpr,
                      recommendationId: routine.recommendationId,
                      source: "onboarding-recommendation",
                    }),
                  }),
                ),
              );
            }
            return { created, existing };
          });
          break;
        } catch (error) {
          const delay = Math.min(40 * 2 ** attempt, 500);
          const canRetry =
            retryableTransactionError(error) &&
            (writeSource === AppDataSource
              ? attempt < 2
              : Date.now() - retryStartedAt + delay < SQLITE_WRITE_RETRY_DEADLINE_MS);
          if (!canRetry) throw error;
          await wait(delay);
        }
      }
      if (!result) throw new Error("Could not apply Routine recommendations");
      if (result.created.length > 0) emitResourceChange(args.company.id, "routine");
      return result;
    } finally {
      if (writeSource !== AppDataSource && writeSource.isInitialized) {
        // Closing an auxiliary handle is cleanup, not part of the committed
        // mutation. Never turn a successful apply into a false client error.
        await writeSource.destroy().catch(() => undefined);
      }
    }
  });
}
