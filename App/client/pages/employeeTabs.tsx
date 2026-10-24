import { EmployeeModelSection } from "@/components/models/EmployeeModelSection";
import React from "react";
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import {
  ArrowUpRight,
  Award,
  Boxes,
  BrainCircuit,
  Brain,
  Calendar,
  Camera,
  Check,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  Globe,
  Handshake,
  KeyRound,
  BookText,
  Phone,
  Plug,
  PlugZap,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import {
  api,
  AutonomyOverview,
  AutonomyWaiver,
  AutonomyWaiverKind,
  Company,
  Employee,
  EmployeeWakeup,
  JournalEntry as JournalEntryT,
  JournalKind,
  MemoryItem,
  McpServer,
  McpTransport,
  Team,
} from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/errors";
import { submitFormOnModEnter } from "../lib/keyboard";
import { employeeSettingsPage } from "../lib/employeeSettingsNav";
import { employeePageAt } from "../lib/subpages";
import { browserAdvancedSummary } from "../lib/employeeBrowser";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { StanddownBanner, StanddownControl } from "../components/StanddownBanner";
import { Modal } from "../components/ui/Modal";
import { useDialog } from "../components/ui/Dialog";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { Disclosure } from "../components/ui/Disclosure";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import type { EmployeeOutletCtx } from "./EmployeeLayout";
import { RecordHistory } from "../components/RecordHistory";

/**
 * The individual employee sub-pages. These were tabs on EmployeeDetail.tsx,
 * then routes in the employee sidebar; now every one of them is a route under
 * `SettingsPage`, reached through the single Settings entry on the employee
 * header. The logic inside each component is mostly a straight lift of the
 * old tab bodies.
 */

function useCtx(): EmployeeOutletCtx {
  return useOutletContext<EmployeeOutletCtx>();
}

/** Owners and admins change an employee; a Member reads it. The server says the same. */
function canEditEmployee(company: Company): boolean {
  return company.role === "owner" || company.role === "admin";
}

/** The line a Member sees where an owner would find the controls. */
function ReadOnlyNote({ emp }: { emp: Employee }) {
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      Only owners and admins can change {emp.name}&apos;s settings.
    </p>
  );
}

/**
 * SoulCard — the Soul editor, rendered by the Soul page under employee
 * Settings alongside everything else you configure about them. Round-trips
 * the Soul body against `AIEmployee.soulBody` via `/api/.../employees/:eid/soul`.
 * The page title already says "Soul", so the card opens with what a Soul is
 * rather than its name again. A Member reads it; only owners and admins save.
 */
function SoulCard({ company, emp }: { company: Company; emp: Employee }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const canEdit = canEditEmployee(company);

  React.useEffect(() => {
    setLoadError(null);
    api
      .get<{ content: string }>(`/api/companies/${company.id}/employees/${emp.id}/soul`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((err) => setLoadError(errorMessage(err, "Could not load the Soul")));
  }, [company.id, emp.id]);

  const dirty = content !== null && saved !== null && content !== saved;

  const save = React.useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, { content });
      setSaved(content);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [company.id, emp.id, content, saving]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Who {emp.name} is and how they work, in plain words. {emp.name} reads it before every chat
          and Routine Run.
        </p>
        {loadError ? (
          <FormError message={loadError} />
        ) : content === null ? (
          <Spinner />
        ) : canEdit ? (
          <>
            <MarkdownEditor
              value={content}
              onChange={setContent}
              rows={16}
              onSave={save}
              aria-label="Soul"
            />
            <FormError message={error} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button onClick={save} loading={saving} disabled={!dirty}>
                {saving ? "Saving…" : "Save Soul"}
              </Button>
              <span className="text-xs text-slate-400 dark:text-slate-500">⌘S to save</span>
              {dirty && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Unsaved changes
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
              {content || "No Soul written yet."}
            </div>
            <ReadOnlyNote emp={emp} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- Model (Settings) tab ----------

/**
 * Employee Settings — the only door off the employee page besides Chat.
 * Everything you configure or inspect about an employee lives behind it, in a
 * rail that keeps the everyday panes up front (who they are, the work they do,
 * what they can reach) and tucks the rest under a collapsed Advanced group.
 *
 * Each sub-route titles itself with its own `TopBar`, so this frame renders
 * the nav and nothing else — that is what lets Journal, Handoffs and MCP keep
 * the primary action they hang off `TopBar.right`.
 */
export function SettingsPage() {
  const ctx = useCtx();
  return (
    <div className="flex flex-col gap-6">
      {/* Above the rail, not inside a tab: a Standdown covers everything this
          employee does, so it must be true on every settings pane rather than
          only on the one that happens to own the button. */}
      <StanddownBanner company={ctx.company} employeeId={ctx.emp.id} />
      <div className="flex flex-col gap-6 md:flex-row">
        <SettingsSideNav company={ctx.company} emp={ctx.emp} />
        <div className="min-w-0 flex-1">
          <Outlet context={ctx} />
        </div>
      </div>
    </div>
  );
}

type SettingsNavEntry = {
  to: string;
  icon: React.ReactNode;
  label: string;
  /**
   * Set when the entry leaves the employee for a company-wide section. The
   * text is the tooltip, because where you land differs per entry — Skills and
   * Routines filter to this employee, Integrations does not.
   */
  away?: string;
};

type SettingsNavGroup = {
  title: string;
  items: SettingsNavEntry[];
  /**
   * Closed until asked for: the heading becomes a toggle, and the group opens
   * by itself when you are on one of its panes.
   */
  collapsible?: boolean;
};

/**
 * What the rail shows by default is what someone setting up an employee
 * reaches for: who they are, the work they do, what they can reach. Autonomy
 * stays in view because it holds this employee's Standdown. The panes you
 * visit now and then sit under Advanced, collapsed, so the rail is a short list
 * instead of a long one.
 *
 * Skills and Routines stay company-level sections — "what is scheduled around
 * here?" is not a per-employee question — so their entries link out to those
 * lists filtered to this employee, and say so with a corner arrow rather than
 * pretending to be a settings pane. Integrations, the one other entry that
 * leaves, is an Advanced link for the same reason.
 */
/** Settings → Access, from the employee page catalogue; the rail links by its last segment. */
const ACCESS_PAGE = employeePageAt("/settings/access");
const ACCESS_PAGE_SEGMENT = ACCESS_PAGE.path.split("/").pop() ?? "access";

function settingsNavGroups(company: Company, emp: Employee): SettingsNavGroup[] {
  return [
    {
      title: "Employee",
      items: [
        { to: "general", icon: <UserRound size={14} />, label: "General" },
        { to: "soul", icon: <Sparkles size={14} />, label: "Soul" },
        { to: "model", icon: <BrainCircuit size={14} />, label: "Model" },
      ],
    },
    {
      title: "Work",
      items: [
        {
          to: `/c/${company.slug}/skills?employee=${emp.slug}`,
          icon: <Wrench size={14} />,
          label: "Skills",
          away: "Opens the company Skills list, filtered to this employee",
        },
        {
          to: `/c/${company.slug}/routines?employee=${emp.slug}`,
          icon: <Calendar size={14} />,
          label: "Routines",
          away: "Opens the company Routines list, filtered to this employee",
        },
      ],
    },
    {
      title: "Access",
      items: [
        // Everything this employee could be granted, in one list. Catalogued
        // in `lib/subpages.ts`, which the ⌘K palette reads too.
        { to: ACCESS_PAGE_SEGMENT, icon: <KeyRound size={14} />, label: ACCESS_PAGE.label },
        { to: "connections", icon: <PlugZap size={14} />, label: "Connections" },
        { to: "autonomy", icon: <Award size={14} />, label: "Autonomy" },
      ],
    },
    {
      title: "Advanced",
      collapsible: true,
      items: [
        { to: "memory", icon: <Brain size={14} />, label: "Memory" },
        { to: "journal", icon: <BookText size={14} />, label: "Journal" },
        { to: "handoffs", icon: <Handshake size={14} />, label: "Handoffs" },
        { to: "phone", icon: <Phone size={14} />, label: "Phone" },
        { to: "mcp", icon: <Plug size={14} />, label: "MCP" },
        { to: "browser", icon: <Globe size={14} />, label: "Browser" },
        {
          to: `/c/${company.slug}/employees/integrations`,
          icon: <Boxes size={14} />,
          label: "Integrations",
          away: "Opens the company-wide Integrations catalog",
        },
      ],
    },
  ];
}

/**
 * Grouped rail on desktop; on a phone the groups collapse into one
 * horizontally scrollable row of pills, because a column of every entry and
 * the content beside it cannot both have a phone's width.
 *
 * The collapsible Advanced group is one piece of state shared by both layouts:
 * a toggle in the column, a pill in the row. It starts closed, opens when you
 * land on one of its panes (a deep link, say) and then stays however you leave
 * it.
 */
function SettingsSideNav({ company, emp }: { company: Company; emp: Employee }) {
  const groups = settingsNavGroups(company, emp);
  const { pathname } = useLocation();
  const scroller = React.useRef<HTMLElement | null>(null);
  const advancedListId = React.useId();

  const page = employeeSettingsPage(pathname, company.slug, emp.slug);
  const onAdvancedPane = groups.some(
    (group) => group.collapsible && group.items.some((item) => !item.away && item.to === page),
  );
  const [advancedOpen, setAdvancedOpen] = React.useState(onAdvancedPane);
  // Open it when the route enters the group. Adjusted during render rather than
  // in an effect, which would paint a frame without the active entry in the
  // rail — and run the scroll-into-view below before that entry exists.
  const [wasOnAdvancedPane, setWasOnAdvancedPane] = React.useState(onAdvancedPane);
  if (onAdvancedPane !== wasOnAdvancedPane) {
    setWasOnAdvancedPane(onAdvancedPane);
    if (onAdvancedPane) setAdvancedOpen(true);
  }

  // The pills do not all fit on a phone, so the one you are actually on is
  // usually off-screen when you arrive. Bring it into view — but only while
  // the pill row is really laid out: at desktop widths it is `display:none`,
  // and asking a box-less element to scroll into view still drags the whole
  // page down past the header.
  React.useEffect(() => {
    const row = scroller.current;
    if (!row || !row.offsetParent) return;
    const active = row.querySelector('[aria-current="page"]');
    if (!(active instanceof HTMLElement)) return;
    row.scrollTo({ left: active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2 });
  }, [pathname]);

  return (
    <>
      <nav
        ref={scroller}
        aria-label="Employee settings"
        className="-mx-8 flex gap-1 overflow-x-auto px-8 pb-1 md:hidden"
      >
        {groups.flatMap((group) =>
          group.collapsible
            ? [
                <button
                  key={group.title}
                  type="button"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  aria-expanded={advancedOpen}
                  title={group.items.map((item) => item.label).join(", ")}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {group.title}
                  <AdvancedChevron open={advancedOpen} />
                </button>,
                ...(advancedOpen
                  ? group.items.map((item) => <SettingsNavItem key={item.to} item={item} pill />)
                  : []),
              ]
            : group.items.map((item) => <SettingsNavItem key={item.to} item={item} pill />),
        )}
      </nav>
      <nav aria-label="Employee settings" className="hidden w-48 shrink-0 md:block">
        {groups.map((group) => (
          <div key={group.title} className="mb-4 last:mb-0">
            {group.collapsible ? (
              <button
                type="button"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
                aria-controls={advancedOpen ? advancedListId : undefined}
                title={group.items.map((item) => item.label).join(", ")}
                className="flex w-full items-center gap-1 px-3 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {group.title}
                <AdvancedChevron open={advancedOpen} />
              </button>
            ) : (
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {group.title}
              </div>
            )}
            {(!group.collapsible || advancedOpen) && (
              <ul
                id={group.collapsible ? advancedListId : undefined}
                className="flex flex-col gap-0.5"
              >
                {group.items.map((item) => (
                  <SettingsNavItem key={item.to} item={item} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </nav>
    </>
  );
}

function AdvancedChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={12}
      aria-hidden="true"
      className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")}
    />
  );
}

function SettingsNavItem({ item, pill }: { item: SettingsNavEntry; pill?: boolean }) {
  const body = (
    <>
      {item.icon}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.away && <ArrowUpRight size={12} className="shrink-0 opacity-50" />}
    </>
  );
  const className = ({ isActive }: { isActive: boolean }) =>
    (pill
      ? "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs "
      : "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ") +
    (isActive && !item.away
      ? pill
        ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
        : "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
      : pill
        ? "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800");

  const link = (
    <NavLink to={item.to} end={!item.away} title={item.away} className={className}>
      {body}
    </NavLink>
  );

  return pill ? link : <li>{link}</li>;
}

export function SoulSettingsPage() {
  const { company, emp } = useCtx();
  return (
    <>
      <TopBar title="Soul" />
      <SoulCard company={company} emp={emp} />
    </>
  );
}

/**
 * General settings for an employee — name, role, slug, profile picture, and
 * team. Slug edits rename the on-disk employee directory (so credential paths
 * stay stable) and bounce the URL once the PATCH lands. The avatar uploader
 * round-trips through the multipart POST on `/employees/:eid/avatar`.
 */
export function GeneralSettingsPage() {
  const { company, emp } = useCtx();
  const canEdit = canEditEmployee(company);
  return (
    <>
      <TopBar title="General" />
      <div className="flex flex-col gap-4">
        {!canEdit && <ReadOnlyNote emp={emp} />}
        <EmployeeBasicsCard company={company} emp={emp} />
        <EmployeeAvatarCard company={company} emp={emp} />
        <EmployeeTeamCard company={company} emp={emp} />
        <RecordHistory
          companyId={company.id}
          companySlug={company.slug}
          targetType="employee"
          targetId={emp.id}
          noun="this employee"
          milestones={[{ label: "Employee hired", at: emp.createdAt, covers: ["create"] }]}
        />
        {canEdit && <EmployeeDangerZoneCard company={company} emp={emp} />}
      </div>
    </>
  );
}

export function BrowserSettingsPage() {
  const { company, emp } = useCtx();
  return (
    <>
      <TopBar title="Browser" />
      <EmployeeBrowserAccessCard company={company} emp={emp} />
    </>
  );
}

/**
 * What this employee does on its own, and the stop for all of it. The stop
 * leads: when someone opens this page in a hurry it is the thing they came
 * for, and it is the reason the pane sits outside the rail's Advanced group.
 */
export function AutonomySettingsPage() {
  const { company, emp } = useCtx();
  return (
    <>
      <TopBar title="Autonomy" />
      <div className="flex flex-col gap-4">
        <EmployeeStanddownCard company={company} emp={emp} />
        <EmployeeAutonomyCard company={company} emp={emp} />
        <EmployeeWakeupsCard company={company} emp={emp} />
      </div>
    </>
  );
}

/**
 * The stop, filed beside the autonomy record because it is the same axis read
 * from the other end: a Waiver is earned, narrow, and widens what this
 * employee may do without a human, while a Standdown is imposed, broad, and
 * stops it. The banner above carries the way back to work when one is in
 * force; this card only ever places one.
 */
function EmployeeStanddownCard({ company, emp }: { company: Company; emp: Employee }) {
  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Stand {emp.name} down
          </div>
          <div className="mt-0.5 max-w-xl text-xs text-slate-500 dark:text-slate-400">
            Stops everything {emp.name} is doing, at once: work in progress is interrupted, Routines
            stop firing, Wakeups and Triggers wait, and chat with {emp.name} is refused. Nothing is
            deleted or changed; an admin returns {emp.name} to work when it is safe.
          </div>
        </div>
        <StanddownControl company={company} scope="employee" scopeId={emp.id} label={emp.name} />
      </CardBody>
    </Card>
  );
}

const WAIVER_KIND_LABEL: Record<AutonomyWaiverKind, string> = {
  browser_approval: "Browser approvals waived",
  routine_approval: "Routine approvals waived",
};

/**
 * The earned-autonomy record (M53a): the 30-day track record the eligibility
 * sweep judges, and every waiver it has ever produced — active or revoked.
 * This card always renders; it is settings, not a queue. There is no grant
 * button here on purpose: promotions are proposed by the sweep and approved
 * from the Approvals inbox. Revoking is the only human write, admin-gated,
 * and it re-arms the gate in the same act.
 */
function EmployeeAutonomyCard({ company, emp }: { company: Company; emp: Employee }) {
  const dialog = useDialog();
  const [overview, setOverview] = React.useState<AutonomyOverview | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      setOverview(
        await api.get<AutonomyOverview>(
          `/api/companies/${company.id}/employees/${emp.id}/autonomy`,
        ),
      );
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the autonomy record"));
    }
  }, [company.id, emp.id]);

  React.useEffect(() => {
    setOverview(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Waiver changes (grants, automatic demotions, another admin's revoke) ride
  // the "employee" live-sync kind, scoped to this employee.
  useLiveRefetch("employee", reload, emp.id);

  async function revoke(waiver: AutonomyWaiver) {
    const ok = await dialog.confirm({
      title: "Revoke this waiver?",
      message:
        `The gate re-arms immediately — ${emp.name} goes back to asking a human before ` +
        (waiver.kind === "browser_approval"
          ? "submitting browser forms."
          : "this routine's runs go ahead."),
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    setRevoking(waiver.id);
    try {
      await api.del(`/api/companies/${company.id}/autonomy-waivers/${waiver.id}`);
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Could not revoke the waiver" });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Earned autonomy
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            The human checks {emp.name} has earned the right to skip, and the record behind them.
            Steady, clean work earns a waiver, which an owner or admin approves under Approvals in
            the Decision stack. Revoking one here brings the check back at once.
          </div>
        </div>
        {loadError ? (
          <FormError message={loadError} />
        ) : overview === null ? (
          <Spinner />
        ) : (
          <>
            <div className="text-xs tabular-nums text-slate-600 dark:text-slate-300">
              Last {overview.stats.windowDays} days: {overview.stats.terminalRuns}{" "}
              {overview.stats.terminalRuns === 1 ? "Run" : "Runs"} · {overview.stats.failed} failed
              · {overview.stats.offGoal} off-goal · {overview.stats.browserApprovalsApproved}{" "}
              browser {overview.stats.browserApprovalsApproved === 1 ? "approval" : "approvals"}{" "}
              granted
            </div>
            {overview.waivers.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No waivers yet: {emp.name} asks a person at every check.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {overview.waivers.map((waiver) => (
                  <li key={waiver.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {WAIVER_KIND_LABEL[waiver.kind]}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        granted {new Date(waiver.grantedAt).toLocaleDateString()}
                      </span>
                      {waiver.revokedAt && (
                        <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                          Revoked {new Date(waiver.revokedAt).toLocaleDateString()}
                          {waiver.revokedReason ? `: ${waiver.revokedReason}` : ""}
                        </span>
                      )}
                      {canManage && !waiver.revokedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          loading={revoking === waiver.id}
                          disabled={revoking !== null}
                          onClick={() => void revoke(waiver)}
                        >
                          {revoking === waiver.id ? "Revoking…" : "Revoke"}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{waiver.evidence}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Wakeups — the timed follow-up sessions this employee scheduled for itself
 * (M54). Pending ones lead with when and why; fired ones stay, muted, with
 * what the session reported back; cancelled ones keep only a chip. The card
 * vanishes entirely while there are none — an empty queue is not news.
 * Cancelling is the one human write, admin-gated; a 409 means the wakeup
 * fired (or was cancelled) between render and click.
 */
function EmployeeWakeupsCard({ company, emp }: { company: Company; emp: Employee }) {
  const dialog = useDialog();
  const [wakeups, setWakeups] = React.useState<EmployeeWakeup[] | null>(null);
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(() => {
    api
      .get<EmployeeWakeup[]>(`/api/companies/${company.id}/wakeups/employee/${emp.id}`)
      .then(setWakeups)
      .catch(() => setWakeups([]));
  }, [company.id, emp.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Wakeups ride the "employee" live-sync kind, scoped to this employee — a
  // session scheduling or firing one lands here without a manual refresh.
  useLiveRefetch("employee", reload, emp.id);

  async function cancel(wakeup: EmployeeWakeup) {
    setCancelling(wakeup.id);
    try {
      await api.post(`/api/companies/${company.id}/wakeups/${wakeup.id}/cancel`, {});
      reload();
    } catch (err) {
      // A 409 means it stopped being pending under us — the reload shows why.
      void dialog.error(err, { title: "Could not cancel the wakeup" });
      reload();
    } finally {
      setCancelling(null);
    }
  }

  if (!wakeups || wakeups.length === 0) return null;

  const pending = wakeups
    .filter((w) => w.status === "pending")
    .sort((a, b) => a.at.localeCompare(b.at));
  const settled = wakeups
    .filter((w) => w.status !== "pending")
    .sort((a, b) => (b.firedAt ?? b.at).localeCompare(a.firedAt ?? a.at));

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Wakeups</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Follow-up sessions {emp.name} scheduled for itself. Cancelling one simply never wakes
            it.
          </div>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {[...pending, ...settled].map((wakeup) => (
            <li key={wakeup.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "text-xs tabular-nums " +
                      (wakeup.status === "pending"
                        ? "font-medium text-slate-900 dark:text-slate-100"
                        : "text-slate-400 dark:text-slate-500")
                    }
                    title={new Date(wakeup.at).toLocaleString()}
                  >
                    {new Date(wakeup.at).toLocaleString()}
                  </span>
                  {wakeup.status === "fired" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Fired
                    </span>
                  )}
                  {wakeup.status === "cancelled" && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Cancelled
                    </span>
                  )}
                </div>
                <div
                  className={
                    "mt-0.5 text-sm " +
                    (wakeup.status === "pending"
                      ? "text-slate-800 dark:text-slate-200"
                      : "text-slate-400 dark:text-slate-500")
                  }
                >
                  {wakeup.brief}
                </div>
                {wakeup.status === "fired" && wakeup.outcomeNote && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                    {wakeup.outcomeNote}
                  </p>
                )}
              </div>
              {canManage && wakeup.status === "pending" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  loading={cancelling === wakeup.id}
                  disabled={cancelling !== null}
                  onClick={() => void cancel(wakeup)}
                >
                  {cancelling === wakeup.id ? "Cancelling…" : "Cancel"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/**
 * Firing an employee used to hang off the bottom of their sidebar. With the
 * sidebar gone it belongs at the far end of General — past everything you
 * might have opened this page to change — rather than one click from Chat.
 */
function EmployeeDangerZoneCard({ company, emp }: { company: Company; emp: Employee }) {
  const navigate = useNavigate();
  const dialog = useDialog();
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove() {
    const ok = await dialog.confirm({
      title: `Fire ${emp.name}?`,
      message: "Their workspace on disk, conversations, routines, and skills will be removed.",
      confirmLabel: "Delete employee",
      variant: "danger",
    });
    if (!ok) return;
    setError(null);
    setDeleting(true);
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}`);
      navigate(`/c/${company.slug}/employees`);
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <FormError message={error} className="mb-3" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Delete employee
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Removes {emp.name}, their workspace on disk, conversations, routines, and skills. This
              cannot be undone.
            </p>
          </div>
          <Button variant="danger" size="sm" loading={deleting} onClick={remove}>
            <Trash2 size={12} /> {deleting ? "Deleting…" : "Delete employee"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * The Team this employee belongs to. Teams are created and named at
 * Settings → Teams; this card only picks one. It used to be an "Org chart"
 * card with a Reports-to picker beside the Team — reporting lines were
 * removed, so the PATCH carries `teamId` alone.
 */
function EmployeeTeamCard({ company, emp }: { company: Company; emp: Employee }) {
  const canEdit = canEditEmployee(company);
  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [teamId, setTeamId] = React.useState<string>(emp.teamId ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setTeamId(emp.teamId ?? "");
  }, [emp.id, emp.teamId]);

  React.useEffect(() => {
    api
      .get<Team[]>(`/api/companies/${company.id}/teams`)
      .then((list) => setTeams(list.filter((t) => !t.archivedAt)))
      .catch(() => setTeams([]));
  }, [company.id]);

  /**
   * Picking a team is the whole edit, so it saves as it is picked — like the
   * run-concurrency choice below — and a refusal puts the old team back with
   * the reason. A team only groups the roster; it grants no access.
   */
  async function choose(next: string) {
    if (saving) return;
    const previous = teamId;
    setTeamId(next);
    setError(null);
    if ((next || null) === (emp.teamId ?? null)) return;
    setSaving(true);
    try {
      await api.patch<Employee>(`/api/companies/${company.id}/employees/${emp.id}`, {
        teamId: next || null,
      });
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setTeamId(previous);
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Team</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            The team this employee belongs to, shown on their card in the Employees list. Create and
            rename teams in Settings → Teams.
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <FormError message={error} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
              Team
              {saving && (
                <span className="inline-flex items-center gap-1 font-normal text-slate-500 dark:text-slate-400">
                  <ButtonSpinner size={11} /> Saving…
                </span>
              )}
            </span>
            <Select
              aria-label="Team"
              aria-busy={saving || undefined}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={teamId}
              onChange={(e) => void choose(e.target.value)}
              disabled={!teams || saving || !canEdit}
            >
              <option value="">— No team —</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </CardBody>
    </Card>
  );
}

function EmployeeAvatarCard({ company, emp }: { company: Company; emp: Employee }) {
  const canEdit = canEditEmployee(company);
  const [avatarKey, setAvatarKey] = React.useState<string | null>(emp.avatarKey ?? null);
  const [uploading, setUploading] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setAvatarKey(emp.avatarKey ?? null);
  }, [emp.id, emp.avatarKey]);

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/companies/${company.id}/employees/${emp.id}/avatar`, {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = res.statusText;
        try {
          msg = JSON.parse(text).error ?? msg;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { avatarKey: string };
      setAvatarKey(data.avatarKey);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setRemoving(true);
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}/avatar`);
      setAvatarKey(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Profile picture
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Shown on their chat header, the employee list, and workspace chat.
            {canEdit && <> PNG, JPEG, GIF, or WebP up to 5&nbsp;MB.</>}
          </div>
        </div>
        <FormError message={error} />
        <div className="flex items-center gap-4">
          <Avatar
            name={emp.name}
            kind="ai"
            size="xl"
            src={employeeAvatarUrl(company.id, emp.id, avatarKey)}
          />
          <div className={canEdit ? "flex flex-wrap items-center gap-2" : "hidden"}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              loading={uploading}
            >
              <Camera size={12} /> {uploading ? "Uploading…" : "Upload new"}
            </Button>
            {avatarKey && (
              <Button
                size="sm"
                variant="ghost"
                onClick={remove}
                loading={removing}
                disabled={uploading}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function EmployeeBasicsCard({ company, emp }: { company: Company; emp: Employee }) {
  const navigate = useNavigate();
  const canEdit = canEditEmployee(company);
  const [name, setName] = React.useState(emp.name);
  const [role, setRole] = React.useState(emp.role);
  const [slug, setSlug] = React.useState(emp.slug);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setName(emp.name);
    setRole(emp.role);
    setSlug(emp.slug);
  }, [emp.id, emp.name, emp.role, emp.slug]);

  const normalizedSlug = normalizeSlug(slug);
  const dirty =
    name.trim() !== emp.name ||
    role.trim() !== emp.role ||
    (normalizedSlug.length > 0 && normalizedSlug !== emp.slug);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    const patch: { name?: string; role?: string; slug?: string } = {};
    if (name.trim() !== emp.name) patch.name = name.trim();
    if (role.trim() !== emp.role) patch.role = role.trim();
    if (normalizedSlug && normalizedSlug !== emp.slug) patch.slug = normalizedSlug;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        patch,
      );
      if (updated.slug !== emp.slug) {
        navigate(`/c/${company.slug}/employees/${updated.slug}/settings/general`, {
          replace: true,
        });
        // Force a soft reload so EmployeeLayout refetches with the new slug.
        window.location.reload();
        return;
      }
      // Reflect new name/role in the sidebar without a full reload.
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const address = `/c/${company.slug}/employees/${normalizedSlug || "…"}`;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Basics</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            How {emp.name} is named across Genosyn — in chat, the Employees list and every Run.
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <FormError message={error} />
          <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-3">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Role" value={role} onChange={(e) => setRole(e.target.value)} />
          </fieldset>
          {/* The address is set once, at hire, and rarely worth changing: it is
              in every link to this employee and names its working folder. */}
          <Disclosure title="Advanced" summary={`Address: ${address}`}>
            <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-1">
              <Input
                label="Slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                onBlur={() => setSlug((s) => normalizeSlug(s))}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                title="Lowercase letters, digits, and single dashes"
                required
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                The last part of {emp.name}&apos;s address,{" "}
                <code className="break-all font-mono">{address}</code>. Changing it breaks links
                people saved, and renames {emp.name}&apos;s working folder on the server.
              </p>
            </fieldset>
          </Disclosure>
          {canEdit && (
            <div className="flex justify-end pt-1">
              <Button type="submit" loading={saving} disabled={!dirty}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether this employee may use a web browser, said plainly, with the switch
 * beside it. Off by default. Where it may browse (the allow list) and whether
 * it asks a person before submitting a form sit behind one Advanced
 * disclosure, whose closed line always says both — the approval is a human
 * gate, so folding it away never hides it. Only owners and admins change any
 * of it; a Member reads the same card.
 */
function EmployeeBrowserAccessCard({ company, emp }: { company: Company; emp: Employee }) {
  const canEdit = canEditEmployee(company);
  const [enabled, setEnabled] = React.useState<boolean>(!!emp.browserEnabled);
  const [allowedHosts, setAllowedHosts] = React.useState<string>(emp.browserAllowedHosts ?? "");
  const [approval, setApproval] = React.useState<boolean>(!!emp.browserApprovalRequired);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [savingApproval, setSavingApproval] = React.useState(false);
  const [savingHosts, setSavingHosts] = React.useState(false);
  const [hostsError, setHostsError] = React.useState<string | null>(null);
  const dialog = useDialog();
  const hostsId = React.useId();

  React.useEffect(() => {
    setEnabled(!!emp.browserEnabled);
    setAllowedHosts(emp.browserAllowedHosts ?? "");
    setApproval(!!emp.browserApprovalRequired);
  }, [emp.id, emp.browserEnabled, emp.browserAllowedHosts, emp.browserApprovalRequired]);

  const hostsDirty = (emp.browserAllowedHosts ?? "") !== allowedHosts;

  async function toggle(next: boolean) {
    if (savingToggle) return;
    setEnabled(next);
    setSavingToggle(true);
    try {
      await api.patch<Employee>(`/api/companies/${company.id}/employees/${emp.id}`, {
        browserEnabled: next,
      });
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setEnabled(!next);
      void dialog.error(err, { title: "Couldn’t update browser access" });
    } finally {
      setSavingToggle(false);
    }
  }

  async function toggleApproval(next: boolean) {
    if (savingApproval) return;
    setApproval(next);
    setSavingApproval(true);
    try {
      await api.patch<Employee>(`/api/companies/${company.id}/employees/${emp.id}`, {
        browserApprovalRequired: next,
      });
    } catch (err) {
      setApproval(!next);
      void dialog.error(err, { title: "Couldn’t update the approval setting" });
    } finally {
      setSavingApproval(false);
    }
  }

  async function saveHosts() {
    if (savingHosts) return;
    setHostsError(null);
    setSavingHosts(true);
    try {
      await api.patch<Employee>(`/api/companies/${company.id}/employees/${emp.id}`, {
        browserAllowedHosts: allowedHosts,
      });
    } catch (err) {
      setHostsError(errorMessage(err, "Could not save the allowed websites"));
    } finally {
      setSavingHosts(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Globe size={16} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Browser access
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Let {emp.name} open web pages in Genosyn&apos;s own Chrome — to read them, click,
                fill in forms and take screenshots — in chat and in Routines. Off by default.
              </p>
            </div>
          </div>
          <ToggleSwitch
            label="Browser access"
            checked={enabled}
            disabled={savingToggle || !canEdit}
            onChange={(next) => void toggle(next)}
          />
        </div>

        {enabled && (
          <Disclosure title="Advanced" summary={browserAdvancedSummary(allowedHosts, approval)}>
            <div className="flex flex-col gap-4">
              <div>
                <label
                  htmlFor={hostsId}
                  className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                >
                  Allowed websites
                </label>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  One per line. Leave it empty to allow any website.{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    mail.google.com
                  </code>{" "}
                  allows exactly that site;{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    *.github.com
                  </code>{" "}
                  allows the domain and every subdomain. A line starting with{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    #
                  </code>{" "}
                  is a note.
                </p>
                <textarea
                  id={hostsId}
                  rows={4}
                  value={allowedHosts}
                  readOnly={!canEdit}
                  onChange={(e) => setAllowedHosts(e.target.value)}
                  placeholder="# Examples:&#10;mail.google.com&#10;*.github.com"
                  className="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-500/25"
                />
                <FormError message={hostsError} className="mt-2" />
                {canEdit && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="secondary"
                      loading={savingHosts}
                      disabled={!hostsDirty}
                      onClick={saveHosts}
                    >
                      {savingHosts ? "Saving…" : "Save allowed websites"}
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    Ask before submitting forms
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Before {emp.name} submits a form on a website, it waits for a person to approve
                    that submission under Approvals, then carries on.
                  </p>
                </div>
                <ToggleSwitch
                  label="Ask before submitting forms"
                  checked={approval}
                  disabled={savingApproval || !canEdit}
                  onChange={(next) => void toggleApproval(next)}
                />
              </div>
            </div>
          </Disclosure>
        )}
        {!canEdit && <ReadOnlyNote emp={emp} />}
      </CardBody>
    </Card>
  );
}

/** An on/off switch: a checkbox with the switch role and its own accessible name. */
function ToggleSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center has-[:disabled]:cursor-not-allowed">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="h-5 w-9 rounded-full bg-slate-200 transition peer-checked:bg-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500/40 peer-disabled:opacity-50 dark:bg-slate-700 dark:peer-checked:bg-indigo-500" />
      <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
    </label>
  );
}

/**
 * Settings → Model: the employee's AI Models, each a self-contained card with
 * its own Advanced section (`components/models/EmployeeModelSection.tsx`).
 */
export function ModelSettingsPage() {
  const { company, emp } = useCtx();
  return (
    <>
      <TopBar title="Model" />
      <EmployeeModelSection company={company} emp={emp} />
    </>
  );
}

// The hire wizard, onboarding and the browser harnesses import it from here.
export { EmployeeModelSection };

const JOURNAL_KIND_STYLE: Record<JournalKind, string> = {
  run: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/30",
  note: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  system:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30",
};

const JOURNAL_KIND_LABEL: Record<JournalKind, string> = {
  run: "Run",
  note: "Note",
  system: "System",
};

/** "Oct 9, 2026, 2:05 PM" — when, to the minute; seconds are noise here. */
function entryTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Per-employee journal. Auto-emits a row for every routine run; humans add
 * free-form notes. The product intent is that future routine prompts can
 * feed the last N entries back into the CLI — but v1 just makes the diary
 * visible so you can audit what the employee has actually done.
 */
export function JournalPage() {
  const { company, emp } = useCtx();
  const [entries, setEntries] = React.useState<JournalEntryT[] | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  async function reload() {
    try {
      const list = await api.get<JournalEntryT[]>(`${base}/journal`);
      setEntries(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the journal"));
      setEntries([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  useLiveRefetch("journal", reload, emp.id);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
    setError(null);
    setSaving(true);
    try {
      const created = await api.post<JournalEntryT>(`${base}/journal`, {
        title: t,
        body: body.trim(),
      });
      setEntries((prev) => (prev ? [created, ...prev] : [created]));
      setTitle("");
      setBody("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete this entry?",
      message: "This journal entry will be permanently removed.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.del(`${base}/journal/${id}`);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the entry" });
    } finally {
      setDeletingId(null);
    }
  }

  async function updateEntry(
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<boolean> {
    try {
      const updated = await api.patch<JournalEntryT>(`${base}/journal/${id}`, patch);
      setEntries((prev) => (prev ? prev.map((e) => (e.id === id ? updated : e)) : prev));
      return true;
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t save the entry" });
      return false;
    }
  }

  return (
    <>
      <TopBar title="Journal" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {emp.name}&apos;s own diary of what they did. Routine Runs add an entry on their own,
            and{" "}
            <strong className="font-medium text-slate-700 dark:text-slate-200">
              {emp.name} rereads the last 7 days before every chat and Routine Run
            </strong>{" "}
            — it is how they remember what happened yesterday. Add a note for them here.
          </p>
          <form onSubmit={addNote} className="mt-3 flex flex-col gap-2">
            <Input
              label="Add note"
              placeholder={`What should ${emp.name} know about today?`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={submitFormOnModEnter}
              aria-label="Detail (optional)"
              rows={3}
              placeholder="Optional detail…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            />
            <FormError message={error} />
            <div>
              <Button type="submit" size="sm" loading={saving} disabled={title.trim().length === 0}>
                <BookText size={14} /> {saving ? "Saving…" : "Add entry"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {loadError ? (
          <FormError message={loadError} />
        ) : entries === null ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            description="Routine runs will appear here automatically, or add a note above."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <JournalEntryRow
                key={e.id}
                entry={e}
                deleting={deletingId === e.id}
                onSave={(patch) => updateEntry(e.id, patch)}
                onDelete={() => remove(e.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function JournalEntryRow({
  entry,
  deleting,
  onSave,
  onDelete,
}: {
  entry: JournalEntryT;
  deleting: boolean;
  onSave: (patch: { title?: string; body?: string }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(entry.title);
  const [draftBody, setDraftBody] = React.useState(entry.body);
  const [saving, setSaving] = React.useState(false);

  function start() {
    setDraftTitle(entry.title);
    setDraftBody(entry.body);
    setEditing(true);
  }

  async function save() {
    const t = draftTitle.trim();
    if (!t) return;
    setSaving(true);
    const ok = await onSave({ title: t, body: draftBody });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <li>
      <Card>
        <CardBody className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={
                  "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
                  JOURNAL_KIND_STYLE[entry.kind]
                }
              >
                {JOURNAL_KIND_LABEL[entry.kind]}
              </span>
              {editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {entry.title}
                </div>
              )}
            </div>
            {editing ? (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={3}
                placeholder="Optional detail…"
                className="mt-2 w-full resize-none rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              />
            ) : (
              entry.body && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
                  {entry.body}
                </div>
              )
            )}
            <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              {entryTime(entry.createdAt)}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" onClick={save} loading={saving} disabled={!draftTitle.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={start} aria-label="Edit entry">
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                loading={deleting}
                aria-label="Delete entry"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}

/**
 * Per-employee Memory. Durable, short "facts" or "preferences" injected into
 * every chat and routine run — distinct from the free-form Soul document and
 * the append-only Journal. Both humans and the AI itself can write here (the
 * AI via the `add_memory` MCP tool).
 */
export function MemoryPage() {
  const { company, emp } = useCtx();
  const [items, setItems] = React.useState<MemoryItem[] | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<MemoryItem[]>(`${base}/memory`);
      setItems(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the memories"));
      setItems([]);
    }
  }, [base]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("memory", reload, emp.id);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
    setError(null);
    setSaving(true);
    try {
      const created = await api.post<MemoryItem>(`${base}/memory`, {
        title: t,
        body: body.trim(),
      });
      setItems((prev) => (prev ? [...prev, created] : [created]));
      setTitle("");
      setBody("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function update(id: string, patch: { title?: string; body?: string }): Promise<boolean> {
    try {
      const updated = await api.patch<MemoryItem>(`${base}/memory/${id}`, patch);
      setItems((prev) => (prev ? prev.map((x) => (x.id === id ? updated : x)) : prev));
      return true;
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t save the memory" });
      return false;
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete this memory?",
      message: `${emp.name} stops recalling this from their next chat or Run.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.del(`${base}/memory/${id}`);
      setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the memory" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <TopBar title="Memory" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Short facts and preferences {emp.name} keeps in mind in{" "}
            <strong className="font-medium text-slate-700 dark:text-slate-200">
              every chat and Routine Run
            </strong>
            . Each is one fact you can add, edit or delete on its own — unlike the Soul, which is
            one document. {emp.name} adds and updates memories too, as they work.
          </p>
          <form onSubmit={add} className="mt-3 flex flex-col gap-2">
            <Input
              label="New memory"
              placeholder="e.g. Prefers ARR over MRR when talking about revenue"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={submitFormOnModEnter}
              aria-label="Elaboration (optional)"
              rows={2}
              placeholder="Optional elaboration…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600 dark:text-slate-100"
            />
            <FormError message={error} />
            <div>
              <Button type="submit" size="sm" loading={saving} disabled={title.trim().length === 0}>
                <Plus size={14} /> {saving ? "Saving…" : "Add memory"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {loadError ? (
          <FormError message={loadError} />
        ) : items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No memories yet"
            description={`Add the first durable fact you want ${emp.name} to recall in every future chat or routine.`}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((m) => (
              <MemoryRow
                key={m.id}
                item={m}
                deleting={deletingId === m.id}
                onSave={(patch) => update(m.id, patch)}
                onDelete={() => remove(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function MemoryRow({
  item,
  deleting,
  onSave,
  onDelete,
}: {
  item: MemoryItem;
  deleting: boolean;
  onSave: (patch: { title?: string; body?: string }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState(item.title);
  const [draftBody, setDraftBody] = React.useState(item.body);
  const [saving, setSaving] = React.useState(false);

  function start() {
    setDraftTitle(item.title);
    setDraftBody(item.body);
    setEditing(true);
  }

  async function save() {
    const t = draftTitle.trim();
    if (!t) return;
    setSaving(true);
    const ok = await onSave({ title: t, body: draftBody });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <li>
      <Card>
        <CardBody className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Brain size={12} className="shrink-0 text-indigo-500 dark:text-indigo-400" />
              {editing ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {item.title}
                </div>
              )}
            </div>
            {editing ? (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={3}
                placeholder="Optional elaboration…"
                className="mt-2 w-full resize-none rounded border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              />
            ) : (
              item.body && (
                <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
                  {item.body}
                </div>
              )
            )}
            <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
              Added {entryTime(item.createdAt)}
              {item.updatedAt && item.updatedAt !== item.createdAt && (
                <> · updated {entryTime(item.updatedAt)}</>
              )}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" onClick={save} loading={saving} disabled={!draftTitle.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  <X size={12} /> Cancel
                </Button>
              </div>
            )}
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={start} aria-label="Edit memory">
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                loading={deleting}
                aria-label="Delete memory"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}

/**
 * Per-employee MCP (Model Context Protocol) servers: extra tools this employee
 * can use, from a server the company runs or trusts, from its next chat or
 * Run. Owners and admins add and remove them; a Member reads the list.
 */
export function McpPage() {
  const { company, emp } = useCtx();
  const canEdit = canEditEmployee(company);
  const [servers, setServers] = React.useState<McpServer[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const dialog = useDialog();
  const base = `/api/companies/${company.id}/employees/${emp.id}/mcp`;

  async function reload() {
    try {
      const list = await api.get<McpServer[]>(base);
      setServers(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the MCP servers"));
      setServers([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  useLiveRefetch("mcpserver", reload, emp.id);

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Remove this MCP server?",
      message: `${emp.name} stops using its tools from their next chat or Run.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await api.del(`${base}/${id}`);
      setServers((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the MCP server" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <TopBar
        title="MCP servers"
        right={canEdit ? <Button onClick={() => setAdding(true)}>Add server</Button> : undefined}
      />
      <p className="-mt-3 mb-4 text-sm text-slate-500 dark:text-slate-400">
        Extra tools for {emp.name} from MCP servers — services that speak the Model Context
        Protocol. {emp.name} can use them in chats and Routine Runs.
      </p>
      {loadError ? (
        <FormError message={loadError} />
      ) : servers === null ? (
        <Spinner />
      ) : servers.length === 0 ? (
        <EmptyState
          title="No MCP servers yet"
          description={
            canEdit
              ? `Add a server to give ${emp.name} its tools.`
              : `An owner or admin can add a server to give ${emp.name} its tools.`
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((s) => (
            <li key={s.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Plug size={14} className="text-slate-500 dark:text-slate-400" />
                      <div className="font-medium">{s.name}</div>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300">
                        {s.transport}
                      </span>
                      {s.guardedTools.length > 0 && (
                        <span
                          className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                          title={`Guarded: ${s.guardedTools.join(", ")}`}
                        >
                          {s.guardedTools.length} guarded
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.transport === "stdio"
                        ? `${s.command ?? ""}${s.args.length ? ` ${s.args.join(" ")}` : ""}`
                        : s.url}
                    </div>
                  </div>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(s.id)}
                      loading={deletingId === s.id}
                      aria-label={`Remove MCP server ${s.name}`}
                    >
                      <Trash2 size={12} />
                    </Button>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <ExternalMcpPanel company={company} emp={emp} />
      </div>
      {adding && (
        <NewMcpModal
          company={company}
          emp={emp}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Read-only panel on Settings → MCP showing the employee's external MCP endpoint.
 * An outside harness (Claude Desktop, Cursor, a custom agent) points its
 * Streamable-HTTP MCP client at this URL and authenticates with a Genosyn API
 * key to drive this employee's built-in `genosyn` tools from outside the app.
 */
function ExternalMcpPanel({ company, emp }: { company: Company; emp: Employee }) {
  const [copied, setCopied] = React.useState(false);
  const url = `${window.location.origin}/api/companies/${company.id}/employees/${emp.id}/mcp/connect`;
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <ExternalLink size={14} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0">
            <div className="text-sm font-medium">Connect an external harness</div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Point any MCP client — Claude Desktop, Cursor, or your own agent — at the URL below to
              use {emp.name}
              {"’"}s built-in Genosyn tools over Streamable HTTP. Authenticate with an{" "}
              <NavLink
                to={`/c/${company.slug}/settings/api-keys`}
                className="underline hover:text-slate-700 dark:hover:text-slate-200"
              >
                API key
              </NavLink>{" "}
              as a Bearer token.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
            {url}
          </code>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const ok = await copyToClipboard(url);
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function NewMcpModal({
  company,
  emp,
  onClose,
  onCreated,
}: {
  company: Company;
  emp: Employee;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<McpTransport>("stdio");
  const [command, setCommand] = React.useState("");
  const [argsLine, setArgsLine] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [envLines, setEnvLines] = React.useState("");
  const [guardedLine, setGuardedLine] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSaving(true);
    try {
      // Space-separated args on one line — MCP command lines are typically
      // short. Users with complex args can paste them with quoting; we keep
      // the input simple on purpose.
      const args = argsLine.trim() ? argsLine.trim().split(/\s+/) : [];
      const env: Record<string, string> = {};
      for (const line of envLines.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
      }
      const body: Record<string, unknown> = { name: name.trim(), transport };
      if (transport === "stdio") {
        body.command = command.trim();
        if (args.length) body.args = args;
      } else {
        body.url = url.trim();
      }
      if (Object.keys(env).length) body.env = env;
      const guardedTools = guardedLine
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (guardedTools.length) body.guardedTools = guardedTools;
      await api.post(`/api/companies/${company.id}/employees/${emp.id}/mcp`, body);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add MCP server" size="lg">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. github"
          required
        />
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Transport
          </label>
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <input type="radio" checked={transport === t} onChange={() => setTransport(t)} />
                {t}
              </label>
            ))}
          </div>
        </div>
        {transport === "stdio" ? (
          <>
            <Input
              label="Command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx"
              required
            />
            <Input
              label="Args (space-separated)"
              value={argsLine}
              onChange={(e) => setArgsLine(e.target.value)}
              placeholder="e.g. -y @modelcontextprotocol/server-github"
            />
          </>
        ) : (
          <Input
            label="URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
          />
        )}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Env (KEY=value, one per line)
          </label>
          <textarea
            value={envLines}
            onChange={(e) => setEnvLines(e.target.value)}
            rows={3}
            className="resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            placeholder="GITHUB_TOKEN=ghp_…"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Guarded tools (optional, comma-separated)
          </label>
          <Input
            value={guardedLine}
            onChange={(e) => setGuardedLine(e.target.value)}
            placeholder="e.g. ads_create_*, ads_update_*"
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Tool names matching these patterns (<code>*</code> wildcard) queue a human Approval
            instead of running. Guard anything that mutates — budget changes, sends, deletes.
          </p>
        </div>
        <FormError message={error} />
        <div className="flex gap-2">
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            {saving ? "Saving…" : "Add server"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
