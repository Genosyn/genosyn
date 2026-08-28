import React from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { api, Company, Me } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui/Spinner";
import { DialogProvider } from "./components/ui/Dialog";
import { ThemeProvider } from "./components/Theme";
import { ChatSessionsProvider } from "./lib/chatSessions";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Forgot from "./pages/Forgot";
import Reset from "./pages/Reset";
import { VerifyEmailLink, VerifyEmailRequired } from "./pages/VerifyEmail";
import Onboarding, { CompanyOnboarding } from "./pages/Onboarding";
import EmployeesLayout from "./pages/EmployeesLayout";
import EmployeesIndex from "./pages/EmployeesIndex";
import EmployeeLayout from "./pages/EmployeeLayout";
import EmployeeNew from "./pages/EmployeeNew";
import EmployeeChat from "./pages/EmployeeChat";
import {
  AutonomySettingsPage,
  BrowserSettingsPage,
  GeneralSettingsPage,
  ModelSettingsPage,
  JournalPage,
  McpPage,
  MemoryPage,
  SettingsPage,
  SoulSettingsPage,
} from "./pages/employeeTabs";
import RoutinesLayout from "./pages/RoutinesLayout";
import RoutinesIndex from "./pages/RoutinesIndex";
import RoutineNew from "./pages/RoutineNew";
import RoutineDetail from "./pages/RoutineDetail";
import SkillsLayout from "./pages/SkillsLayout";
import SkillsIndex from "./pages/SkillsIndex";
import SkillNew from "./pages/SkillNew";
import SkillDetail from "./pages/SkillDetail";
import SettingsLayout from "./pages/SettingsLayout";
import { SettingsCompany, SettingsMembers, SettingsSecrets } from "./pages/Settings";
import AccountLayout from "./pages/AccountLayout";
import { AccountProfile } from "./pages/AccountProfile";
import { AccountSecurity } from "./pages/AccountSecurity";
import AdminLayout from "./pages/AdminLayout";
import { AdminOverview } from "./pages/AdminOverview";
import { AdminGeneral } from "./pages/AdminGeneral";
import { AdminInstanceHealth } from "./pages/AdminInstanceHealth";
import { AdminDbConsole } from "./pages/AdminDbConsole";
import { AdminMigrations } from "./pages/AdminMigrations";
import { AdminEmail } from "./pages/AdminEmail";
import { AdminIntegrations } from "./pages/AdminIntegrations";
import { AdminSignups } from "./pages/AdminSignups";
import { AdminSSO } from "./pages/AdminSSO";
import { AdminBackup } from "./pages/AdminBackup";
import { AdminUsers } from "./pages/AdminUsers";
import { AdminCompanies } from "./pages/AdminCompanies";
import { ProductIntegrationsPage, SettingsIntegrations } from "./pages/SettingsIntegrations";
import { SettingsMemberBrowsers } from "./pages/SettingsMemberBrowsers";
import { PRODUCT_INTEGRATION_KEYS, type ProductIntegrationKey } from "./lib/productIntegrations";
import { SettingsTeams } from "./pages/SettingsTeams";
import { SettingsTags } from "./pages/SettingsTags";
import { SettingsApiKeys } from "./pages/SettingsApiKeys";
import { SettingsEmail, SettingsEmailProviders } from "./pages/SettingsEmail";
import { SettingsEmailLogs } from "./pages/SettingsEmailLogs";
import { SettingsSystemHealth } from "./pages/SettingsSystemHealth";
import { HandoffsPage } from "./pages/EmployeeHandoffs";
import Inbox from "./pages/Inbox";
import MailLayout from "./pages/MailLayout";
import MailThreadList from "./pages/MailThreadList";
import MailThreadView from "./pages/MailThreadView";
import MailRules from "./pages/MailRules";
import MailHandovers from "./pages/MailHandovers";
import MailSettings from "./pages/MailSettings";
import HomePage from "./pages/Home";
import TldrsLayout from "./pages/TldrsLayout";
import TldrsIndex from "./pages/TldrsIndex";
import TldrSettingsPage from "./pages/TldrSettings";
import { EmployeeConnections } from "./pages/EmployeeConnections";
import Invite from "./pages/Invite";
import TasksLayout from "./pages/TasksLayout";
import TasksIndex from "./pages/TasksIndex";
import TasksReview from "./pages/TasksReview";
import ProjectNew from "./pages/ProjectNew";
import ProjectDetail from "./pages/ProjectDetail";
import Vault from "./pages/Vault";
import Approvals from "./pages/Approvals";
import Decisions from "./pages/Decisions";
import Goals from "./pages/Goals";
import Revisions from "./pages/Revisions";
import Initiatives from "./pages/Initiatives";
import AuditLog from "./pages/AuditLog";
import Usage from "./pages/Usage";
import BasesLayout from "./pages/BasesLayout";
import BasesIndex from "./pages/BasesIndex";
import BaseNew from "./pages/BaseNew";
import BaseDetail from "./pages/BaseDetail";
import BaseRecordPage from "./pages/BaseRecordPage";
import Workspace from "./pages/Workspace";
import PipelinesLayout from "./pages/PipelinesLayout";
import PipelinesIndex from "./pages/PipelinesIndex";
import PipelineNew from "./pages/PipelineNew";
import PipelineDetail from "./pages/PipelineDetail";
import NotesLayout from "./pages/NotesLayout";
import NotesIndex from "./pages/NotesIndex";
import NotebookDetail from "./pages/NotebookDetail";
import NoteDetail from "./pages/NoteDetail";
import ResourcesIndex from "./pages/ResourcesIndex";
import ResourceDetail from "./pages/ResourceDetail";
import ResourcesLayout from "./pages/ResourcesLayout";
import RepositoriesLayout from "./pages/RepositoriesLayout";
import RepositoriesIndex from "./pages/RepositoriesIndex";
import RepositoryOverview from "./pages/RepositoryOverview";
import RepositoryFiles from "./pages/RepositoryFiles";
import RepositoryHistory from "./pages/RepositoryHistory";
import RepositoryAi from "./pages/RepositoryAi";
import RepositoryAccess from "./pages/RepositoryAccess";
import RepositorySettings from "./pages/RepositorySettings";
import CustomersLayout from "./pages/CustomersLayout";
import MeetingsLayout from "./pages/MeetingsLayout";
import MeetingsAgenda from "./pages/MeetingsAgenda";
import MeetingsRecorded from "./pages/MeetingsRecorded";
import MeetingsCalendars from "./pages/MeetingsCalendars";
import MeetingsAiAccess from "./pages/MeetingsAiAccess";
import MeetingDetail from "./pages/MeetingDetail";
import RevenueLayout from "./pages/RevenueLayout";
import RevenueIndex from "./pages/RevenueIndex";
import RevenueDeals from "./pages/RevenueDeals";
import RevenueDealDetail from "./pages/RevenueDealDetail";
import RevenueContacts from "./pages/RevenueContacts";
import RevenueContactDetail from "./pages/RevenueContactDetail";
import RevenueSequences from "./pages/RevenueSequences";
import RevenueSequenceDetail from "./pages/RevenueSequenceDetail";
import RevenueSignals from "./pages/RevenueSignals";
import RevenueSignalDetail from "./pages/RevenueSignalDetail";
import RevenueSuppressions from "./pages/RevenueSuppressions";
import RevenueAiAccess from "./pages/RevenueAiAccess";
import RevenueAccounts from "./pages/RevenueAccounts";
import RevenueAccountDetail from "./pages/RevenueAccountDetail";
import RevenueFollowUps from "./pages/RevenueFollowUps";
import RevenueImports from "./pages/RevenueImports";
import RevenueActivities from "./pages/RevenueActivities";
import RevenuePartnershipDetail from "./pages/RevenuePartnershipDetail";
import RevenuePartnerships from "./pages/RevenuePartnerships";
import RevenueSetup from "./pages/RevenueSetup";
import RevenueDataQuality from "./pages/RevenueDataQuality";
import MarketingLayout from "./pages/MarketingLayout";
import Budgets from "./pages/Budgets";
import { CompanyPolicies } from "./pages/CompanyPolicies";
import { MarketingAiAccessPage } from "./pages/MarketingAiAccess";
import { MarketingCampaignDetailPage } from "./pages/MarketingCampaignDetail";
import { MarketingCampaignsPage } from "./pages/MarketingCampaigns";
import { MarketingCreativePage } from "./pages/MarketingCreative";
import { MarketingExperimentsPage } from "./pages/MarketingExperiments";
import { MarketingOverviewPage } from "./pages/MarketingOverview";
import CustomersIndex from "./pages/CustomersIndex";
import CustomerNew from "./pages/CustomerNew";
import CustomerDetail from "./pages/CustomerDetail";
import CustomerStatement from "./pages/CustomerStatement";
import ContractsIndex from "./pages/ContractsIndex";
import SignatureLayout from "@/pages/SignatureLayout";
import SignaturesIndex from "@/pages/SignaturesIndex";
import SignatureNew from "@/pages/SignatureNew";
import SignatureDetail from "@/pages/SignatureDetail";
import SignatureAiAccess from "@/pages/SignatureAiAccess";
import PublicSigning from "@/pages/PublicSigning";
import FinanceLayout from "./pages/FinanceLayout";
import FinanceIndex from "./pages/FinanceIndex";
import FinanceProducts from "./pages/FinanceProducts";
import FinanceTaxRates from "./pages/FinanceTaxRates";
import FinanceInvoices from "./pages/FinanceInvoices";
import FinanceInvoiceNew from "./pages/FinanceInvoiceNew";
import FinanceInvoiceDetail from "./pages/FinanceInvoiceDetail";
import FinanceCreditNotes from "./pages/FinanceCreditNotes";
import FinanceCreditNoteDetail from "./pages/FinanceCreditNoteDetail";
import FinanceVendorCredits from "./pages/FinanceVendorCredits";
import FinanceVendorCreditDetail from "./pages/FinanceVendorCreditDetail";
import FinanceRecurringInvoices from "./pages/FinanceRecurringInvoices";
import FinanceRecurringInvoiceNew from "./pages/FinanceRecurringInvoiceNew";
import FinanceRecurringInvoiceDetail from "./pages/FinanceRecurringInvoiceDetail";
import FinanceEstimates from "./pages/FinanceEstimates";
import FinanceEstimateNew from "./pages/FinanceEstimateNew";
import FinanceEstimateDetail from "./pages/FinanceEstimateDetail";
import FinanceTemplates from "./pages/FinanceTemplates";
import FinanceSettings from "./pages/FinanceSettings";
import FinanceAiAccess from "./pages/FinanceAiAccess";
import FinanceAccounts from "./pages/FinanceAccounts";
import FinanceJournal from "./pages/FinanceJournal";
import FinanceProposals from "./pages/FinanceProposals";
import FinanceTransactions from "./pages/FinanceTransactions";
import FinanceTrialBalance from "./pages/FinanceTrialBalance";
import FinanceReports from "./pages/FinanceReports";
import FinanceReconcile from "./pages/FinanceReconcile";
import FinanceCardExpenses from "./pages/FinanceCardExpenses";
import FinanceCurrencies from "./pages/FinanceCurrencies";
import FinancePeriods from "./pages/FinancePeriods";
import FinanceVendors from "./pages/FinanceVendors";
import FinanceBills from "./pages/FinanceBills";
import FinanceBillNew from "./pages/FinanceBillNew";
import FinanceBillDetail from "./pages/FinanceBillDetail";
import ExploreLayout from "./pages/ExploreLayout";
import ExploreIndex from "./pages/ExploreIndex";
import ExploreChartDetail from "./pages/ExploreChartDetail";
import ExploreDashboardDetail from "./pages/ExploreDashboardDetail";
import Help from "./pages/Help";

type AuthState =
  | { status: "loading" }
  | { status: "anon" }
  | { status: "ready"; me: Me; companies: Company[] };

export default function App() {
  const location = useLocation();
  const isPublicSigning = location.pathname.startsWith("/sign/");
  const [auth, setAuth] = React.useState<AuthState>({ status: "loading" });

  const refreshAuthenticatedState = React.useCallback(async () => {
    const me = await api.get<Me>("/api/auth/me");
    const companies = await api.get<Company[]>("/api/companies");
    setAuth({ status: "ready", me, companies });
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      await refreshAuthenticatedState();
    } catch {
      setAuth({ status: "anon" });
    }
  }, [refreshAuthenticatedState]);

  React.useEffect(() => {
    if (!isPublicSigning) void refresh();
  }, [isPublicSigning, refresh]);

  return (
    <ThemeProvider>
      <DialogProvider>
        {isPublicSigning ? (
          <Routes>
            <Route path="/sign/:token" element={<PublicSigning />} />
          </Routes>
        ) : auth.status === "loading" ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={24} />
          </div>
        ) : auth.status === "anon" ? (
          <Routes>
            <Route path="/login" element={<Login onAuth={refresh} />} />
            <Route path="/signup" element={<Signup onAuth={refresh} />} />
            <Route path="/forgot" element={<Forgot />} />
            <Route path="/reset/:token" element={<Reset />} />
            <Route
              path="/verify-email/:token"
              element={<VerifyEmailLink onVerified={refresh} />}
            />
            <Route path="/invite/:token" element={<Navigate to="/login" replace />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route
              path="/verify-email/:token"
              element={<VerifyEmailLink onVerified={refresh} />}
            />
            <Route
              path="*"
              element={
                auth.me.emailVerificationRequired ? (
                  <VerifyEmailRequired email={auth.me.email} />
                ) : (
                  <AuthedRoutes
                    me={auth.me}
                    companies={auth.companies}
                    onChanged={refresh}
                    onCompaniesChanged={refreshAuthenticatedState}
                  />
                )
              }
            />
          </Routes>
        )}
      </DialogProvider>
    </ThemeProvider>
  );
}

function AuthedRoutes({
  me,
  companies,
  onChanged,
  onCompaniesChanged,
}: {
  me: Me;
  companies: Company[];
  onChanged: () => Promise<void>;
  onCompaniesChanged: () => Promise<void>;
}) {
  if (companies.length === 0) {
    return (
      <Routes>
        <Route path="/onboarding" element={<Onboarding onDone={onCompaniesChanged} />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route
          path="/security"
          element={
            <div className="mx-auto min-h-full max-w-4xl p-8">
              <AccountSecurity />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/" element={<Navigate to={`/c/${companies[0].slug}`} replace />} />
      {/* Creating the first company refreshes auth while the browser is still
        on `/onboarding`. Preserve that intent across the route-tree swap so
        the new company opens its guided launch instead of briefly falling
        through to the company home. */}
      <Route
        path="/onboarding"
        element={<Navigate to={`/c/${companies[0].slug}/onboarding`} replace />}
      />
      <Route
        path="/c/:companySlug/*"
        element={
          <CompanyRoutes
            me={me}
            companies={companies}
            onChanged={onChanged}
            onCompaniesChanged={onCompaniesChanged}
          />
        }
      />
      <Route path="*" element={<Navigate to={`/c/${companies[0].slug}`} replace />} />
    </Routes>
  );
}

function CompanyRoutes({
  me,
  companies,
  onChanged,
  onCompaniesChanged,
}: {
  me: Me;
  companies: Company[];
  onChanged: () => Promise<void>;
  onCompaniesChanged: () => Promise<void>;
}) {
  const { companySlug } = useParams();
  const company = companies.find((c) => c.slug === companySlug);
  if (!company) return <Navigate to="/" replace />;

  return (
    <AppShell
      me={me}
      companies={companies}
      current={company}
      onAuthChanged={onChanged}
      onCompaniesChanged={onCompaniesChanged}
    >
      <ChatSessionsProvider key={company.id}>
        <Routes>
          {/* Home — the post-sign-in landing page: everything that needs the
            member's attention plus quick navigation. */}
          <Route index element={<HomePage company={company} me={me} />} />
          <Route path="onboarding" element={<CompanyOnboarding company={company} />} />

          {/* TLDRs — periodic company briefings written by a selected AI Employee. */}
          <Route path="tldrs" element={<TldrsLayout company={company} />}>
            <Route index element={<TldrsIndex />} />
            <Route path="settings" element={<TldrSettingsPage />} />
          </Route>

          {/* Every product exposes a curated view of the shared Integration
            catalog. Settings keeps the complete catalog; these routes show
            only the Connections that belong in the active product workflow. */}
          {PRODUCT_INTEGRATION_KEYS.map((product: ProductIntegrationKey) => (
            <Route
              key={product}
              path={`${product}/integrations`}
              element={<ProductIntegrationsPage company={company} product={product} />}
            />
          ))}

          {/* Inbox — company-wide rollup of today's journal entries. */}
          <Route path="inbox" element={<Inbox company={company} />} />

          {/* Email (M25) — the company's Gmail inboxes. Sidebar = folders +
            labels + automation; the index is the thread list, filtered by
            `?view=` / `?label=` query params. */}
          <Route path="mail" element={<MailLayout company={company} />}>
            <Route index element={<MailThreadList />} />
            <Route path="t/:threadId" element={<MailThreadView />} />
            <Route path="rules" element={<MailRules />} />
            <Route path="handovers" element={<MailHandovers />} />
            <Route path="settings" element={<MailSettings />} />
          </Route>

          {/* Employees section — sidebar = roster */}
          <Route path="employees" element={<EmployeesLayout company={company} />}>
            <Route index element={<EmployeesIndex company={company} />} />
            <Route path="new" element={<EmployeeNew company={company} />} />
          </Route>

          {/* Selected-employee section — no sidebar. An employee is two places:
            the conversation, and Settings, which holds everything else you can
            configure or inspect about them. */}
          <Route
            path="employees/:empSlug"
            element={<EmployeeLayout company={company} currentUserId={me.id} />}
          >
            <Route index element={<Navigate to="chat" replace />} />
            <Route path="chat" element={<EmployeeChat />} />
            <Route path="settings" element={<SettingsPage />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<GeneralSettingsPage />} />
              <Route path="soul" element={<SoulSettingsPage />} />
              <Route path="model" element={<ModelSettingsPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="journal" element={<JournalPage />} />
              <Route path="handoffs" element={<HandoffsPage />} />
              <Route path="connections" element={<EmployeeConnections />} />
              <Route path="mcp" element={<McpPage />} />
              <Route path="browser" element={<BrowserSettingsPage />} />
              <Route path="autonomy" element={<AutonomySettingsPage />} />
            </Route>
          </Route>

          {/* Routines — every scheduled routine in the company. Sits beside
            Employees under the AI section: a routine always belongs to an
            employee, but "what is scheduled around here?" is a company-level
            question, and answering it used to mean opening each employee in
            turn. */}
          <Route path="routines" element={<RoutinesLayout company={company} />}>
            <Route index element={<RoutinesIndex company={company} />} />
            <Route path="new" element={<RoutineNew company={company} />} />
            {/* Two segments, not one: a routine slug is unique only within its
              employee, so `:routineSlug` alone would be ambiguous. */}
            <Route path=":empSlug/:routineSlug" element={<RoutineDetail company={company} />} />
          </Route>

          {/* Skills — every playbook in the company. Same shape as Routines, and
            for the same reason: a skill always belongs to an employee, but
            "what do we know how to do?" is a company-level question. */}
          <Route path="skills" element={<SkillsLayout company={company} />}>
            <Route index element={<SkillsIndex company={company} />} />
            <Route path="new" element={<SkillNew company={company} />} />
            {/* Two segments, not one: a skill slug is unique only within its
              employee, so `:skillSlug` alone would be ambiguous. */}
            <Route path=":empSlug/:skillSlug" element={<SkillDetail company={company} />} />
          </Route>

          {/* Tasks (Projects + Todos) — task manager. */}
          <Route path="tasks" element={<TasksLayout company={company} />}>
            <Route index element={<TasksIndex company={company} />} />
            <Route path="review" element={<TasksReview company={company} />} />
            <Route path="new" element={<ProjectNew company={company} />} />
            <Route path="p/:pSlug" element={<ProjectDetail company={company} me={me} />} />
          </Route>

          {/* Vault — encrypted logins, authenticators, API keys, and secure notes. */}
          <Route path="vault" element={<Vault company={company} />} />

          {/* Bases (Airtable-style) — structured data for the company. */}
          <Route path="bases" element={<BasesLayout company={company} />}>
            <Route index element={<BasesIndex company={company} />} />
            <Route path="new" element={<BaseNew company={company} />} />
            <Route path=":baseSlug" element={<BaseDetail company={company} />} />
            <Route path=":baseSlug/:tableSlug" element={<BaseDetail company={company} />} />
            <Route
              path=":baseSlug/:tableSlug/r/:recordId"
              element={<BaseRecordPage company={company} />}
            />
          </Route>

          {/* Pipelines (M10) — n8n-style visual automation, separate from Routines. */}
          <Route path="pipelines" element={<PipelinesLayout company={company} />}>
            <Route index element={<PipelinesIndex company={company} />} />
            <Route path="new" element={<PipelineNew company={company} />} />
            <Route path=":pSlug" element={<PipelineDetail company={company} />} />
          </Route>

          {/* Notes — Notion-style company-wide markdown knowledge base.
            URL shape: /notes/<notebook>/<note>. The bare /notes lists
            notebooks; /notes/<notebook> shows that notebook's contents. */}
          <Route path="notes" element={<NotesLayout company={company} />}>
            <Route index element={<NotesIndex company={company} />} />
            <Route path=":notebookSlug" element={<NotebookDetail company={company} />} />
            <Route path=":notebookSlug/:noteSlug" element={<NoteDetail company={company} />} />
          </Route>

          {/* Resources (M18) — knowledge ingestion. URL / ebook / paste →
            extracted text, queryable by AI employees via MCP tools. */}
          <Route path="resources" element={<ResourcesLayout />}>
            <Route index element={<ResourcesIndex company={company} />} />
            <Route path=":slug" element={<ResourceDetail company={company} />} />
          </Route>

          {/* Code — provider-agnostic git repositories the company adds so
            granted AI employees can read, commit, and push real code. */}
          <Route
            path="repositories"
            element={<RepositoriesLayout company={company} currentUserId={me.id} />}
          >
            <Route index element={<RepositoriesIndex company={company} />} />
            <Route path=":slug" element={<RepositoryOverview />} />
            <Route path=":slug/files" element={<RepositoryFiles />} />
            <Route path=":slug/history" element={<RepositoryHistory />} />
            <Route path=":slug/ai" element={<RepositoryAi />} />
            {/* A session is linkable, so a Member can send someone straight to
              the diff they need to look at — and so switching sessions is a
              navigation rather than hidden component state. */}
            <Route path=":slug/ai/:sessionId" element={<RepositoryAi />} />
            <Route path=":slug/access" element={<RepositoryAccess />} />
            <Route path=":slug/settings" element={<RepositorySettings />} />
          </Route>

          {/* Customers — standalone section (moved out of Finance). Customer
            accounts, plus the signed contracts uploaded against them. */}
          <Route path="customers" element={<CustomersLayout company={company} />}>
            <Route index element={<CustomersIndex />} />
            <Route path="new" element={<CustomerNew />} />
            <Route path="contracts" element={<ContractsIndex />} />
            <Route path=":customerSlug" element={<CustomerDetail />} />
            <Route path=":customerSlug/statement" element={<CustomerStatement />} />
            <Route path=":customerSlug/edit" element={<CustomerNew />} />
          </Route>

          {/* Signatures — AI-native document preparation, delivery, and
            public recipient signing with a complete audit trail. */}
          <Route path="signatures" element={<SignatureLayout company={company} />}>
            <Route index element={<SignaturesIndex />} />
            <Route path="new" element={<SignatureNew />} />
            <Route path="ai-access" element={<SignatureAiAccess />} />
            <Route path=":envelopeId" element={<SignatureDetail />} />
          </Route>

          {/* Calendar + Meetings (M44) — the mirrored agenda, recorded calls
            and their transcripts, and the per-calendar Grants that decide
            which AI Employee may read or record them. */}
          <Route path="meetings" element={<MeetingsLayout company={company} />}>
            <Route index element={<MeetingsAgenda />} />
            <Route path="recorded" element={<MeetingsRecorded />} />
            <Route path="calendars" element={<MeetingsCalendars />} />
            <Route path="ai-access" element={<MeetingsAiAccess />} />
            <Route path=":meetingId" element={<MeetingDetail />} />
          </Route>

          {/* Revenue (M32) — follow-ups, accounts, contacts, deals,
            partnerships, outbound, signals, and reporting. Customer is the
            shared account row from prospect through billing. */}
          <Route path="revenue" element={<RevenueLayout company={company} />}>
            <Route index element={<RevenueIndex />} />
            <Route path="follow-ups" element={<RevenueFollowUps />} />
            <Route path="deals" element={<RevenueDeals />} />
            <Route path="deals/:dealId" element={<RevenueDealDetail />} />
            <Route path="accounts" element={<RevenueAccounts />} />
            <Route path="accounts/:accountId" element={<RevenueAccountDetail />} />
            <Route path="contacts" element={<RevenueContacts />} />
            <Route path="contacts/:contactId" element={<RevenueContactDetail />} />
            <Route path="partnerships" element={<RevenuePartnerships />} />
            <Route path="partnerships/:partnershipId" element={<RevenuePartnershipDetail />} />
            <Route path="sequences" element={<RevenueSequences />} />
            <Route path="sequences/:sequenceId" element={<RevenueSequenceDetail />} />
            <Route path="signals" element={<RevenueSignals />} />
            <Route path="signals/:signalId" element={<RevenueSignalDetail />} />
            <Route path="activities" element={<RevenueActivities />} />
            <Route path="suppressions" element={<RevenueSuppressions />} />
            <Route path="ai-access" element={<RevenueAiAccess />} />
            <Route path="imports" element={<RevenueImports />} />
            <Route path="data-quality" element={<RevenueDataQuality />} />
            <Route path="setup" element={<RevenueSetup />} />
          </Route>

          <Route path="marketing" element={<MarketingLayout company={company} />}>
            <Route index element={<MarketingOverviewPage />} />
            <Route path="campaigns" element={<MarketingCampaignsPage />} />
            <Route path="campaigns/:campaignId" element={<MarketingCampaignDetailPage />} />
            <Route path="creative" element={<MarketingCreativePage />} />
            <Route path="experiments" element={<MarketingExperimentsPage />} />
            {/* Monthly ad-spend envelopes (M53b). The server's exhaustion
              notification links to /marketing/budgets. */}
            <Route path="budgets" element={<Budgets company={company} me={me} />} />
            <Route path="ai-access" element={<MarketingAiAccessPage />} />
          </Route>

          {/* Finance (M19 Phase A) — Products, Tax rates, Invoices, Bills,
            ledger. Native invoicing with browser-print to PDF and email send
            via the company's EmailProvider. Customers moved to their own
            section above. */}
          <Route path="finance" element={<FinanceLayout company={company} />}>
            <Route index element={<FinanceIndex />} />
            <Route path="products" element={<FinanceProducts />} />
            <Route path="tax-rates" element={<FinanceTaxRates />} />
            <Route path="invoices" element={<FinanceInvoices />} />
            <Route path="invoices/new" element={<FinanceInvoiceNew />} />
            <Route path="invoices/:invoiceSlug" element={<FinanceInvoiceDetail />} />
            <Route path="invoices/:invoiceSlug/edit" element={<FinanceInvoiceNew />} />
            <Route path="credit-notes" element={<FinanceCreditNotes />} />
            <Route path="credit-notes/:creditSlug" element={<FinanceCreditNoteDetail />} />
            <Route path="recurring-invoices" element={<FinanceRecurringInvoices />} />
            <Route path="recurring-invoices/new" element={<FinanceRecurringInvoiceNew />} />
            <Route
              path="recurring-invoices/:recurringSlug"
              element={<FinanceRecurringInvoiceDetail />}
            />
            <Route
              path="recurring-invoices/:recurringSlug/edit"
              element={<FinanceRecurringInvoiceNew />}
            />
            <Route path="estimates" element={<FinanceEstimates />} />
            <Route path="estimates/new" element={<FinanceEstimateNew />} />
            <Route path="estimates/:estimateSlug" element={<FinanceEstimateDetail />} />
            <Route path="estimates/:estimateSlug/edit" element={<FinanceEstimateNew />} />
            <Route path="accounts" element={<FinanceAccounts />} />
            <Route path="transactions" element={<FinanceTransactions />} />
            <Route path="journal" element={<FinanceJournal />} />
            <Route path="proposals" element={<FinanceProposals />} />
            <Route path="trial-balance" element={<FinanceTrialBalance />} />
            <Route path="reports" element={<FinanceReports />} />
            <Route path="reconcile" element={<FinanceReconcile />} />
            <Route path="card-expenses" element={<FinanceCardExpenses />} />
            <Route path="currencies" element={<FinanceCurrencies />} />
            <Route path="templates" element={<FinanceTemplates />} />
            <Route path="settings" element={<FinanceSettings />} />
            <Route path="ai-access" element={<FinanceAiAccess />} />
            <Route path="periods" element={<FinancePeriods />} />
            <Route path="vendors" element={<FinanceVendors />} />
            <Route path="bills" element={<FinanceBills />} />
            <Route path="bills/new" element={<FinanceBillNew />} />
            <Route path="bills/:billSlug" element={<FinanceBillDetail />} />
            <Route path="vendor-credits" element={<FinanceVendorCredits />} />
            <Route path="vendor-credits/:creditSlug" element={<FinanceVendorCreditDetail />} />
          </Route>

          {/* Explore (M20) — Metabase-style analytics. Saved Charts (SQL +
            viz) and Dashboards (grids of cards) over the company's
            postgres / mysql / clickhouse Integration Connections. */}
          <Route path="explore" element={<ExploreLayout company={company} />}>
            <Route index element={<ExploreIndex company={company} />} />
            <Route path="charts/:slug" element={<ExploreChartDetail company={company} />} />
            <Route path="dashboards/:slug" element={<ExploreDashboardDetail company={company} />} />
          </Route>

          <Route path="approvals" element={<Approvals company={company} />} />
          <Route path="decisions" element={<Decisions company={company} me={me} />} />
          <Route path="goals" element={<Goals company={company} me={me} />} />
          <Route path="revisions" element={<Revisions company={company} me={me} />} />
          <Route path="initiatives" element={<Initiatives company={company} me={me} />} />
          <Route path="help" element={<Help company={company} />} />

          {/* Workspace chat — Slack-style channels and DMs (M9). */}
          <Route path="workspace" element={<Workspace company={company} me={me} />} />
          <Route path="workspace/:channelId" element={<Workspace company={company} me={me} />} />

          {/* Settings — company-scoped only. Its own sidebar, like
            Employees/Tasks/Bases. Account-global pages live under /account;
            install-wide pages live under /admin. */}
          <Route
            path="settings"
            element={<SettingsLayout company={company} me={me} onCompaniesChanged={onChanged} />}
          >
            <Route index element={<Navigate to="company" replace />} />
            <Route path="company" element={<SettingsCompany />} />
            <Route path="members" element={<SettingsMembers />} />
            <Route path="teams" element={<SettingsTeams />} />
            <Route path="tags" element={<SettingsTags />} />
            {/* Company policies (M53b) — rules binding every AI employee. */}
            <Route path="policies" element={<CompanyPolicies />} />
            <Route path="integrations" element={<SettingsIntegrations />} />
            <Route path="browsers" element={<SettingsMemberBrowsers />} />
            <Route path="email" element={<SettingsEmail />}>
              <Route index element={<Navigate to="providers" replace />} />
              <Route path="providers" element={<SettingsEmailProviders />} />
              <Route path="logs" element={<SettingsEmailLogs />} />
            </Route>
            <Route path="secrets" element={<SettingsSecrets />} />
            <Route path="api-keys" element={<SettingsApiKeys />} />
            <Route path="usage" element={<Usage />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="system-health" element={<SettingsSystemHealth />} />
          </Route>

          {/* Account — global to the signed-in user, not the current company.
            Profile, password, 2FA, and per-device notifications live here. */}
          <Route
            path="account"
            element={<AccountLayout company={company} me={me} onCompaniesChanged={onChanged} />}
          >
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<AccountProfile />} />
            <Route path="security" element={<AccountSecurity />} />
          </Route>

          {/* Admin — install-wide operations that span every company: instance
            health, backups, and the users/companies directory. Restricted to
            instance master admins; anyone else is bounced to the company home. */}
          <Route
            path="admin"
            element={
              me.isMasterAdmin ? (
                <AdminLayout company={company} me={me} onCompaniesChanged={onChanged} />
              ) : (
                <Navigate to={`/c/${company.slug}`} replace />
              )
            }
          >
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<AdminOverview />} />
            <Route path="general" element={<AdminGeneral />} />
            <Route path="instance-health" element={<AdminInstanceHealth />} />
            <Route path="db" element={<AdminDbConsole />} />
            <Route path="migrations" element={<AdminMigrations />} />
            <Route path="email" element={<AdminEmail />} />
            <Route path="integrations" element={<AdminIntegrations />} />
            <Route path="signups" element={<AdminSignups />} />
            <Route path="sso" element={<AdminSSO />} />
            <Route path="backup" element={<AdminBackup />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="companies" element={<AdminCompanies />} />
          </Route>

          {/* Legacy redirects: Routines and Skills used to be per-employee tabs. */}
          <Route
            path="employees/:empSlug/routines"
            element={<EmployeeRoutinesRedirect companySlug={company.slug} />}
          />
          <Route
            path="employees/:empSlug/skills"
            element={<EmployeeSkillsRedirect companySlug={company.slug} />}
          />

          {/* Legacy redirects: the employee sub-nav collapsed into Settings.
            Declared as siblings rather than children so the redirect fires
            without mounting EmployeeLayout (which fetches the whole roster).
            The company catch-all below is a silent bounce to Home, so a stale
            bookmark without one of these fails invisibly. */}
          {EMPLOYEE_SETTINGS_MOVED.map((tab) => (
            <Route
              key={tab}
              path={`employees/:empSlug/${tab}`}
              element={<EmployeeSettingsRedirect companySlug={company.slug} tab={tab} />}
            />
          ))}

          {/* Legacy redirects: Profile moved to Account; Backup moved to Admin. */}
          <Route
            path="settings/profile"
            element={<Navigate to={`/c/${company.slug}/account/profile`} replace />}
          />
          <Route
            path="settings/backup"
            element={<Navigate to={`/c/${company.slug}/admin/backup`} replace />}
          />

          {/* Legacy redirects: Customers used to live under Finance. */}
          <Route
            path="finance/customers"
            element={<Navigate to={`/c/${company.slug}/customers`} replace />}
          />
          <Route
            path="finance/customers/new"
            element={<Navigate to={`/c/${company.slug}/customers/new`} replace />}
          />
          <Route
            path="finance/customers/:customerSlug/edit"
            element={<CustomerEditRedirect companySlug={company.slug} />}
          />

          {/* Legacy redirects: Usage / Audit used to live at the top level. */}
          <Route
            path="usage"
            element={<Navigate to={`/c/${company.slug}/settings/usage`} replace />}
          />
          <Route
            path="audit"
            element={<Navigate to={`/c/${company.slug}/settings/audit`} replace />}
          />

          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </ChatSessionsProvider>
    </AppShell>
  );
}

/**
 * Routines moved out of the per-employee sub-nav into their own section, so
 * `/employees/:empSlug/routines` now lands on the company Routines list
 * filtered to that employee.
 *
 * Any query string rides along: the Home "Failed routines" panel and the
 * Journal both deep-link with `?routine=<id>&run=<id>`, and the Routines index
 * resolves that id and forwards to the run. When such a link is in play we skip
 * the `employee` filter — the index is about to redirect away from itself.
 */
function EmployeeRoutinesRedirect({ companySlug }: { companySlug: string }) {
  const { empSlug } = useParams();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (empSlug && !params.has("routine")) params.set("employee", empSlug);
  const qs = params.toString();
  return <Navigate to={`/c/${companySlug}/routines${qs ? `?${qs}` : ""}`} replace />;
}

/**
 * The pages that used to sit beside Chat in the employee sidebar and now live
 * under Settings. Kept as a list because both the routes and their redirects
 * are generated from it.
 */
const EMPLOYEE_SETTINGS_MOVED = [
  "journal",
  "handoffs",
  "memory",
  "connections",
  "mcp",
] as const;

/**
 * The employee sidebar collapsed into Chat + Settings, so the five surfaces
 * that used to have their own top-level entry now answer at
 * `/employees/:empSlug/settings/<tab>`. Any query string rides along.
 */
function EmployeeSettingsRedirect({
  companySlug,
  tab,
}: {
  companySlug: string;
  tab: string;
}) {
  const { empSlug } = useParams();
  const { search } = useLocation();
  return (
    <Navigate to={`/c/${companySlug}/employees/${empSlug}/settings/${tab}${search}`} replace />
  );
}

/**
 * Skills moved out of the per-employee sub-nav into their own section, so
 * `/employees/:empSlug/skills` now lands on the company Skills list filtered
 * to that employee.
 */
function EmployeeSkillsRedirect({ companySlug }: { companySlug: string }) {
  const { empSlug } = useParams();
  const qs = empSlug ? `?employee=${encodeURIComponent(empSlug)}` : "";
  return <Navigate to={`/c/${companySlug}/skills${qs}`} replace />;
}

/** Redirect the old `/finance/customers/:slug/edit` URL to its new home in
 *  the standalone Customers section, preserving the slug. */
function CustomerEditRedirect({ companySlug }: { companySlug: string }) {
  const { customerSlug } = useParams();
  return <Navigate to={`/c/${companySlug}/customers/${customerSlug}/edit`} replace />;
}
