import React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { Company, Employee } from "../lib/api";
import { Avatar, employeeAvatarUrl } from "./ui/Avatar";
import { StartGroupChatButton } from "./workspace/StartGroupChatButton";

/**
 * The one bar an AI Employee gets.
 *
 * An employee is someone you talk to, so their page is the conversation, and
 * everything you can configure or inspect about them lives behind a single
 * Settings door. That leaves two destinations rather than the long sidebar
 * this replaced — which is why the header, not a sidebar, now carries the way
 * back to the roster and the switch between the two.
 *
 * Rendered by the chat (which fills `subtitle` with the live thread title) and
 * by the employee Settings page, so the switch sits in the same place whichever
 * side you are looking at.
 */
export function EmployeeHeader({
  company,
  emp,
  active,
  subtitle,
  actions,
  currentUserId,
}: {
  company: Company;
  emp: Employee;
  active: "chat" | "settings";
  /** Second line under the name — the chat uses it for the thread title. */
  subtitle?: React.ReactNode;
  /** Page-specific controls, placed before the Chat / Settings switch. */
  actions?: React.ReactNode;
  /** The signed-in Member; with it, the header offers a group chat with this employee. */
  currentUserId?: string;
}) {
  const base = `/c/${company.slug}/employees/${emp.slug}`;
  const allActions =
    actions !== undefined || currentUserId ? (
      <>
        {currentUserId && (
          <StartGroupChatButton company={company} meId={currentUserId} employeeId={emp.id} />
        )}
        {actions}
      </>
    ) : undefined;

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:flex-nowrap sm:px-6 dark:border-slate-800 dark:bg-slate-950">
      <Link
        to={`/c/${company.slug}/employees`}
        title="All employees"
        aria-label="All employees"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      >
        <ArrowLeft size={16} />
      </Link>
      <Avatar
        name={emp.name}
        kind="ai"
        size="lg"
        src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {emp.name}
          </div>
          <div className="hidden truncate text-xs text-slate-500 sm:block dark:text-slate-400">
            {emp.role}
          </div>
          {/* Without a connected AI Model the employee can't answer a message or
              run a Routine, so say so on both sides of the switch, one click
              from the fix — rather than after a chat message fails. */}
          {emp.chatReady === false && (
            <Link
              to={`${base}/settings/model`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30 dark:hover:bg-amber-500/20"
            >
              <AlertTriangle size={11} aria-hidden="true" /> No AI Model
              <span className="hidden sm:inline"> connected</span>
            </Link>
          )}
        </div>
        {subtitle !== undefined && (
          <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">{subtitle}</div>
        )}
      </div>
      {/* The switch is the only way off Chat, so it must never be the thing
          that overflows. Ordering the actions after it, in a wrapping row,
          means a wide action — the conversation's browser picker — drops to a
          second line on a phone instead of pushing the switch off-screen.
          Narrow actions still share the first line. */}
      {allActions !== undefined && (
        <div className="order-last flex shrink-0 items-center gap-2 sm:order-none">
          {allActions}
        </div>
      )}
      <nav
        aria-label="Employee"
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900"
      >
        <EmployeeTab
          to={`${base}/chat`}
          icon={<MessageSquare size={13} />}
          label="Chat"
          current={active === "chat"}
        />
        <EmployeeTab
          to={`${base}/settings`}
          icon={<SettingsIcon size={13} />}
          label="Settings"
          current={active === "settings"}
        />
      </nav>
    </header>
  );
}

function EmployeeTab({
  to,
  icon,
  label,
  current,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  current: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      title={label}
      className={
        "touch-target relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition " +
        (current
          ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100")
      }
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}
