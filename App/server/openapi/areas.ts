import type { DiscoveredRoute } from "./routeDiscovery.js";
import { adminRouter } from "../routes/admin.js";
import { apiKeysRouter } from "../routes/apiKeys.js";
import { approvalsRouter } from "../routes/approvals.js";
import { askAiRouter } from "../routes/askAi.js";
import { auditRouter } from "../routes/audit.js";
import { authRouter } from "../routes/auth.js";
import { autonomyRouter } from "../routes/autonomy.js";
import { backupDestinationsRouter } from "../routes/backupDestinations.js";
import { backupsRouter } from "../routes/backups.js";
import { basesRouter } from "../routes/bases.js";
import { boardLettersRouter } from "../routes/boardLetters.js";
import { browserSessionsRouter } from "../routes/browserSessions.js";
import { budgetsRouter } from "../routes/budgets.js";
import { cardExpensesRouter } from "../routes/cardExpenses.js";
import { careersRouter } from "../routes/careers.js";
import { chatSurfaceBindRouter, chatSurfacesRouter } from "../routes/chatSurfaces.js";
import { customerChannelsRouter } from "../routes/customerChannels.js";
import { companiesRouter } from "../routes/companies.js";
import { companyMcpRouter } from "../routes/companyMcp.js";
import { connectedAppsRouter } from "../routes/connectedApps.js";
import { companyPoliciesRouter } from "../routes/companyPolicies.js";
import { companySsoRouter } from "../routes/companySso.js";
import { companySsoAuthRouter } from "../routes/companySsoAuth.js";
import { contractsRouter } from "../routes/contracts.js";
import { customerMergeRouter } from "../routes/customerMerge.js";
import { decisionPoliciesRouter } from "../routes/decisionPolicies.js";
import { decisionsRouter } from "../routes/decisions.js";
import { decisionStackSettingsRouter } from "../routes/decisionStackSettings.js";
import { emailLogsRouter } from "../routes/emailLogs.js";
import { emailProvidersRouter } from "../routes/emailProviders.js";
import { employeesRouter } from "../routes/employees.js";
import { employeeSurfaceRouter } from "../routes/employeeSurface.js";
import { employeeAccessRouter } from "../routes/employeeAccess.js";
import { employeeWorkQueueRouter } from "../routes/employeeWorkQueue.js";
import { exploreRouter } from "../routes/explore.js";
import { financeRouter } from "../routes/finance.js";
import { formsRouter } from "../routes/forms.js";
import { goalsRouter } from "../routes/goals.js";
import { handoffsRouter } from "../routes/handoffs.js";
import { homeRouter } from "../routes/home.js";
import { improvementRouter } from "../routes/improvement.js";
import { inboxRouter } from "../routes/inbox.js";
import { integrationsRouter } from "../routes/integrations.js";
import { invitationsRouter } from "../routes/invitations.js";
import { mailRouter } from "../routes/mail.js";
import { mailMeetingsRouter } from "../routes/mailMeetings.js";
import { marketingRouter } from "../routes/marketing.js";
import { mcpRouter } from "../routes/mcp.js";
import { mcpConnectRouter } from "../routes/mcpConnect.js";
import { oauthConsentRouter } from "../routes/mcpOauth.js";
import { meetingsRouter } from "../routes/meetings.js";
import { memberBrowsersRouter } from "../routes/memberBrowsers.js";
import { modelsRouter } from "../routes/models.js";
import { companyModelsRouter } from "../routes/companyModels.js";
import { navigationRouter } from "../routes/navigation.js";
import { notebooksRouter } from "../routes/notebooks.js";
import { notesRouter } from "../routes/notes.js";
import { notificationsRouter } from "../routes/notifications.js";
import { passkeyLoginRouter } from "../routes/passkeyLogin.js";
import { phoneRouter } from "../routes/phone.js";
import { pipelinesRouter } from "../routes/pipelines.js";
import { proactiveRouter } from "../routes/proactive.js";
import { projectsRouter } from "../routes/projects.js";
import { publicFormsRouter } from "../routes/publicForms.js";
import { publicSignaturesRouter } from "../routes/publicSignatures.js";
import { publicDataRoomsRouter } from "../routes/publicDataRooms.js";
import { dataRoomsRouter } from "../routes/dataRooms.js";
import { pushRouter } from "../routes/push.js";
import { reactivityRouter } from "../routes/reactivity.js";
import { recordHistoryRouter } from "../routes/recordHistory.js";
import { recruitingRouter } from "../routes/recruiting.js";
import { repositoriesRouter } from "../routes/repositories.js";
import { repositoryContentRouter } from "../routes/repositoryContent.js";
import { resourceFoldersRouter } from "../routes/resourceFolders.js";
import { resourcesRouter } from "../routes/resources.js";
import { revenueRouter } from "../routes/revenue.js";
import { revenueOperationsRouter } from "../routes/revenueOperations.js";
import { routineChecksRouter } from "../routes/routineChecks.js";
import { routineFoldersRouter } from "../routes/routineFolders.js";
import { routinesRouter } from "../routes/routines.js";
import { searchRouter } from "../routes/search.js";
import { secretsRouter } from "../routes/secrets.js";
import { signaturesRouter } from "../routes/signatures.js";
import { skillsRouter } from "../routes/skills.js";
import { ssoRouter } from "../routes/sso.js";
import { standdownsRouter } from "../routes/standdowns.js";
import { subsidiariesRouter } from "../routes/subsidiaries.js";
import { systemHealthRouter } from "../routes/systemHealth.js";
import { tagsRouter } from "../routes/tags.js";
import { teamsRouter } from "../routes/teams.js";
import { templatesRouter } from "../routes/templates.js";
import { tldrsRouter } from "../routes/tldrs.js";
import { toolCatalogueRouter } from "../routes/toolCatalogue.js";
import { twoFactorRouter } from "../routes/twoFactor.js";
import { usageRouter } from "../routes/usage.js";
import { vaultRouter } from "../routes/vault.js";
import { vaultSourcesRouter } from "../routes/vaultSources.js";
import { webhooksRouter } from "../routes/webhooks.js";
import { workspaceRouter } from "../routes/workspace.js";
import { workspaceDiscussionsRouter } from "../routes/workspaceDiscussions.js";
import { workTimelineRouter } from "../routes/workTimeline.js";

/**
 * The product area — the OpenAPI tag — every documented route belongs to.
 *
 * Areas follow the routers, because a router is how the App already groups an
 * area's endpoints: the skills router owns `/employees/{eid}/skills` even
 * though its path starts like an employee's. A few routers serve two areas the
 * product keeps apart (Banking and Customers live in the Finance router), so a
 * rule may also name the paths it covers.
 *
 * A route takes the first rule matching the innermost router it sits in, then
 * its parent routers'. The coverage test fails on a documented route no rule
 * places, so a new router gets an area the day it lands.
 *
 * Built lazily: `routes/openapi.ts` imports this module through the spec, and
 * this module imports every router — including that one — so reading the
 * routers at module load would hit them before they exist.
 */

export type Area = {
  name: string;
  description: string;
};

/** Every area, in the order the API reference lists them. */
export const AREAS: readonly Area[] = [
  {
    name: "Auth",
    description:
      "Sign-in, sign-up, sessions, passkeys, two-factor authentication and the signed-in account.",
  },
  { name: "Companies", description: "The company itself, its Members, roles and invitations." },
  {
    name: "API Keys",
    description: "Personal API keys. Minting and revoking a key needs a signed-in browser session.",
  },
  {
    name: "Connected apps",
    description:
      "Apps such as claude.ai and ChatGPT that a Member approved, through OAuth, to use the Genosyn MCP server as them: the consent screen's calls, and listing and disconnecting them. A signed-in browser session only.",
  },
  {
    name: "Home",
    description: "The post-sign-in landing page, the daily inbox, navigation and search.",
  },
  {
    name: "Employees",
    description:
      "AI Employees: their profile, Soul, journal, memory, templates, work queue and Access — every Grant they hold.",
  },
  {
    name: "Employee chat",
    description: "Direct conversations with an AI Employee and their attachments.",
  },
  {
    name: "AI Models",
    description:
      "The company's AI Models and their credentials, and which of them each AI Employee uses. Owners and admins, from a signed-in browser session only.",
  },
  { name: "Skills", description: "Markdown playbooks attached to AI Employees." },
  { name: "Tool catalogue", description: "The tools an AI Employee can be given." },
  {
    name: "Routines",
    description: "Scheduled AI work, its Runs, Checks, browser recordings and Folders.",
  },
  { name: "Goals", description: "Measurable objectives every Routine is checked against." },
  {
    name: "Improvement",
    description: "Lessons from graded Runs and Revision proposals that fix them.",
  },
  {
    name: "Proactive work",
    description: "Standing work, Triggers, Wakeups, Workstreams and Initiatives.",
  },
  { name: "Autonomy", description: "Waivers an AI Employee earns from a human gate." },
  {
    name: "Standdowns",
    description: "Revocable stops on all AI work at company, employee or Routine scope.",
  },
  { name: "Policies", description: "Company-wide policies every AI Employee is bound by." },
  { name: "Budgets", description: "Monthly ad-spend envelopes." },
  { name: "Decisions", description: "The Decision stack, decision policies and its settings." },
  { name: "Approvals", description: "Actions held for an owner or admin to approve." },
  { name: "Handoffs", description: "Work one AI Employee hands to another." },
  { name: "Teams", description: "Groups of AI Employees." },
  {
    name: "TLDRs",
    description: "Periodic AI-written recaps, standing questions and their suggested actions.",
  },
  {
    name: "Letters to the board",
    description: "The monthly letter to owners and admins, its writer and auditor.",
  },
  { name: "Ask AI", description: "Questions to AI Employees about whatever is on screen." },
  { name: "Workspace chat", description: "Channels, direct messages, reactions and attachments." },
  {
    name: "Chat surfaces",
    description: "Slack, Microsoft Teams, WhatsApp and Telegram identities.",
  },
  {
    name: "Customer channels",
    description:
      "Slack channels linked to a Customer, where an AI Employee keeps notes and answers.",
  },
  { name: "Tasks", description: "Projects, todos and their comments." },
  { name: "Notes", description: "Notebooks and notes." },
  { name: "Resources", description: "The library AI Employees read from, and its Folders." },
  { name: "Bases", description: "Airtable-style tables, views, rows, comments and attachments." },
  { name: "Forms", description: "Public forms that write rows into a Base." },
  {
    name: "Repositories",
    description: "Version-controlled workspaces, their files, commits and Work sessions.",
  },
  { name: "Pipelines", description: "Trigger-to-step automations and their Runs." },
  { name: "Explore", description: "Charts and dashboards over database Connections." },
  { name: "Integrations", description: "The Integration catalog, Connections and their Grants." },
  { name: "MCP servers", description: "MCP servers configured for an AI Employee." },
  {
    name: "MCP",
    description:
      "Streamable HTTP MCP endpoints: the Genosyn MCP server, which offers every operation an API key may call, and an AI Employee's built-in tools.",
  },
  { name: "Browser", description: "Live sessions in an AI Employee's browser." },
  {
    name: "Member browsers",
    description: "Chrome browsers Members connect from their own computers.",
  },
  {
    name: "Phone numbers",
    description: "Twilio numbers given to AI Employees, with their texts and calls.",
  },
  {
    name: "Email",
    description: "The company's mailboxes: threads, drafts, rules, handovers and AI analysis.",
  },
  { name: "Email delivery", description: "Transactional email providers and the delivery log." },
  {
    name: "Revenue",
    description: "Contacts, accounts, deals, activities, sequences, signals, imports and reports.",
  },
  { name: "Meetings", description: "Connected calendars, recordings and transcripts." },
  { name: "Marketing", description: "Campaigns, Creative, Experiments and performance." },
  {
    name: "Recruiting",
    description: "Openings, Applications, Scorecards and the careers site settings.",
  },
  {
    name: "Data rooms",
    description:
      "Rooms of documents shared with guests outside the company, their guests, activity and questions, and the room's AI work. Owners and admins only.",
  },
  {
    name: "Customers",
    description: "Customer accounts, their contacts, statements and contracts.",
  },
  {
    name: "Finance",
    description: "Invoices, estimates, bills, the ledger, reports and Finance settings.",
  },
  {
    name: "Banking",
    description: "Bank and card feeds, their transactions, matching and categories.",
  },
  { name: "Document signing", description: "Signature envelopes and their recipients." },
  { name: "Secrets", description: "Company secrets." },
  { name: "Vault", description: "Encrypted logins, passkeys, notes and Vault sources." },
  { name: "Tags", description: "Company tags and their assignments." },
  { name: "Notifications", description: "The notification feed and browser push subscriptions." },
  { name: "Audit log", description: "The company's audit log and each record's history." },
  { name: "Usage", description: "AI usage and system health." },
  { name: "Company SSO", description: "Single sign-on for one company." },
  { name: "Admin", description: "Instance administration for master admins." },
  { name: "Backups", description: "Instance backups and their destinations, for master admins." },
  {
    name: "Public signing",
    description:
      "The pages a document's recipients sign on, authenticated by the link they were sent.",
  },
  { name: "Public forms", description: "Published forms anyone with the link can fill in." },
  {
    name: "Guest data rooms",
    description:
      "The data room a guest reads and asks questions in, authenticated by their private link.",
  },
  { name: "Careers site", description: "The public careers site: Openings and applications." },
  {
    name: "Inbound webhooks",
    description: "URLs your own systems call to start Routines and Pipelines or post to a channel.",
  },
  { name: "System", description: "Health and the API's own description." },
];

type AreaRule = { router: unknown; area: string; paths?: RegExp };

let rules: AreaRule[] | null = null;

function areaRules(): AreaRule[] {
  rules ??= [
    { router: authRouter, area: "Auth" },
    { router: passkeyLoginRouter, area: "Auth" },
    { router: twoFactorRouter, area: "Auth" },
    { router: ssoRouter, area: "Auth" },
    { router: companySsoAuthRouter, area: "Auth" },
    { router: companiesRouter, area: "Companies" },
    { router: invitationsRouter, area: "Companies" },
    { router: apiKeysRouter, area: "API Keys" },
    { router: connectedAppsRouter, area: "Connected apps" },
    { router: oauthConsentRouter, area: "Connected apps" },
    { router: homeRouter, area: "Home" },
    { router: inboxRouter, area: "Home" },
    { router: navigationRouter, area: "Home" },
    { router: searchRouter, area: "Home" },
    { router: workTimelineRouter, area: "Home" },
    { router: employeesRouter, area: "Employees" },
    { router: templatesRouter, area: "Employees" },
    { router: employeeWorkQueueRouter, area: "Employees" },
    {
      router: employeeSurfaceRouter,
      area: "Employee chat",
      paths: /\/(conversations|chat-attachments)(\/|$)/,
    },
    { router: employeeSurfaceRouter, area: "Employees" },
    { router: employeeAccessRouter, area: "Employees" },
    { router: modelsRouter, area: "AI Models" },
    { router: companyModelsRouter, area: "AI Models" },
    { router: skillsRouter, area: "Skills" },
    { router: toolCatalogueRouter, area: "Tool catalogue" },
    { router: routinesRouter, area: "Routines" },
    { router: routineFoldersRouter, area: "Routines" },
    { router: routineChecksRouter, area: "Routines" },
    { router: goalsRouter, area: "Goals" },
    { router: improvementRouter, area: "Improvement" },
    { router: proactiveRouter, area: "Proactive work" },
    { router: reactivityRouter, area: "Proactive work" },
    { router: autonomyRouter, area: "Autonomy" },
    { router: standdownsRouter, area: "Standdowns" },
    { router: companyPoliciesRouter, area: "Policies" },
    { router: budgetsRouter, area: "Budgets" },
    { router: decisionsRouter, area: "Decisions" },
    { router: decisionPoliciesRouter, area: "Decisions" },
    { router: decisionStackSettingsRouter, area: "Decisions" },
    { router: approvalsRouter, area: "Approvals" },
    { router: handoffsRouter, area: "Handoffs" },
    { router: teamsRouter, area: "Teams" },
    { router: tldrsRouter, area: "TLDRs" },
    { router: boardLettersRouter, area: "Letters to the board" },
    { router: askAiRouter, area: "Ask AI" },
    { router: workspaceRouter, area: "Workspace chat" },
    { router: workspaceDiscussionsRouter, area: "Workspace chat" },
    { router: chatSurfacesRouter, area: "Chat surfaces" },
    { router: chatSurfaceBindRouter, area: "Chat surfaces" },
    { router: customerChannelsRouter, area: "Customer channels" },
    { router: projectsRouter, area: "Tasks" },
    { router: notebooksRouter, area: "Notes" },
    { router: notesRouter, area: "Notes" },
    { router: resourcesRouter, area: "Resources" },
    { router: resourceFoldersRouter, area: "Resources" },
    { router: basesRouter, area: "Bases" },
    { router: formsRouter, area: "Forms" },
    { router: repositoriesRouter, area: "Repositories" },
    { router: repositoryContentRouter, area: "Repositories" },
    { router: pipelinesRouter, area: "Pipelines" },
    { router: exploreRouter, area: "Explore" },
    { router: integrationsRouter, area: "Integrations" },
    { router: mcpRouter, area: "MCP servers" },
    { router: mcpConnectRouter, area: "MCP" },
    { router: companyMcpRouter, area: "MCP" },
    { router: browserSessionsRouter, area: "Browser" },
    { router: memberBrowsersRouter, area: "Member browsers" },
    { router: phoneRouter, area: "Phone numbers" },
    { router: mailRouter, area: "Email" },
    { router: mailMeetingsRouter, area: "Email" },
    { router: emailProvidersRouter, area: "Email delivery" },
    { router: emailLogsRouter, area: "Email delivery" },
    { router: revenueRouter, area: "Revenue" },
    { router: revenueOperationsRouter, area: "Revenue" },
    { router: meetingsRouter, area: "Meetings" },
    { router: marketingRouter, area: "Marketing" },
    { router: recruitingRouter, area: "Recruiting" },
    { router: dataRoomsRouter, area: "Data rooms" },
    { router: customerMergeRouter, area: "Customers" },
    { router: contractsRouter, area: "Customers" },
    { router: subsidiariesRouter, area: "Finance" },
    {
      router: financeRouter,
      area: "Customers",
      paths: /\/(customers|customer-refunds)(\/|$)|\/exports\/customers\.csv$/,
    },
    {
      router: financeRouter,
      area: "Banking",
      paths: /\/(bank-feeds|bank-transactions|banking)(\/|$)/,
    },
    { router: financeRouter, area: "Finance" },
    { router: cardExpensesRouter, area: "Banking" },
    { router: signaturesRouter, area: "Document signing" },
    { router: secretsRouter, area: "Secrets" },
    { router: vaultSourcesRouter, area: "Vault" },
    { router: vaultRouter, area: "Vault" },
    { router: tagsRouter, area: "Tags" },
    { router: notificationsRouter, area: "Notifications" },
    { router: pushRouter, area: "Notifications" },
    { router: auditRouter, area: "Audit log" },
    { router: recordHistoryRouter, area: "Audit log" },
    { router: usageRouter, area: "Usage" },
    { router: systemHealthRouter, area: "Usage" },
    { router: companySsoRouter, area: "Company SSO" },
    { router: adminRouter, area: "Admin" },
    { router: backupsRouter, area: "Backups" },
    { router: backupDestinationsRouter, area: "Backups" },
    { router: publicSignaturesRouter, area: "Public signing" },
    { router: publicFormsRouter, area: "Public forms" },
    { router: publicDataRoomsRouter, area: "Guest data rooms" },
    { router: careersRouter, area: "Careers site" },
    { router: webhooksRouter, area: "Inbound webhooks" },
  ];
  return rules;
}

/** Routes registered on the app itself rather than on a router. */
const APP_LEVEL_AREAS: Record<string, string> = {
  "/api/health": "System",
  "/api/openapi.json": "System",
};

/**
 * The area of a discovered route, or null when no rule places it. Routers are
 * tried innermost first, so a nested router's own rule wins over its parent's.
 */
export function areaOf(route: Pick<DiscoveredRoute, "routers" | "path">): string | null {
  for (const router of [...route.routers].reverse()) {
    for (const rule of areaRules()) {
      if (rule.router !== router) continue;
      if (rule.paths && !rule.paths.test(route.path)) continue;
      return rule.area;
    }
  }
  return APP_LEVEL_AREAS[route.path] ?? null;
}
