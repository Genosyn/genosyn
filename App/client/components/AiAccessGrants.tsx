import React from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Lock,
  MessageSquare,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";

/**
 * The parts of a section "AI access" page where an AI Employee holds a level
 * on a ladder only once it is granted one — read < invoice < full in Finance,
 * read < write < send in Revenue: the ladder, the level picker, and the card
 * listing who holds what. Finance and Revenue draw the same page from these on
 * purpose. Pages where every AI Employee always holds a level (Resources,
 * Routines) use `AiAccessToggle` instead.
 */

export type AiAccessLevel<L extends string> = {
  value: L;
  label: string;
  /** A few words, under the level's name on its card. */
  tagline: string;
  /** Everything the level allows, on its card and in the picker. */
  hint: string;
  icon: React.ReactNode;
  /** Tint for the icon on its own: the picker's button, the read-only badge. */
  iconColor: string;
  /** Filled icon chip: the level's card and its row in the picker. */
  iconWrap: string;
};

type GrantEmployee = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

export type AiAccessGrant<L extends string> = {
  id: string;
  employeeId: string;
  accessLevel: L;
  createdAt: string;
  employee: GrantEmployee | null;
};

export type AiAccessCandidate = GrantEmployee;

function levelOf<L extends string>(levels: AiAccessLevel<L>[], value: L): AiAccessLevel<L> {
  return levels.find((level) => level.value === value) ?? levels[0];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The ladder, narrowest level first. Each level includes the one before it:
 * its hint says so in words, and the chevron on the seam between two levels
 * says so at a glance.
 */
export function AiAccessLevelLadder<L extends string>({ levels }: { levels: AiAccessLevel<L>[] }) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Access levels
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Each level includes everything in the one before it.
        </p>
      </div>
      <AiAccessLevelSteps levels={levels} />
    </section>
  );
}

function AiAccessLevelSteps<L extends string>({ levels }: { levels: AiAccessLevel<L>[] }) {
  return (
    <ol className="grid rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 lg:grid-cols-3">
      {levels.map((level, index) => (
        <li
          key={level.value}
          className={clsx(
            "relative p-5",
            index > 0 &&
              "border-t border-slate-100 dark:border-slate-800 lg:border-l lg:border-t-0",
          )}
        >
          {index > 0 && (
            <span
              aria-hidden
              className="absolute -top-3 left-9 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 lg:-left-3 lg:top-9 lg:-translate-y-1/2 lg:translate-x-0"
            >
              <ChevronRight size={13} className="rotate-90 lg:rotate-0" />
            </span>
          )}
          <div className="flex items-center gap-3">
            <span
              className={clsx(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                level.iconWrap,
              )}
            >
              {level.icon}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {level.label}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{level.tagline}</div>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">{level.hint}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * A button showing a level (its tinted icon and name) that opens the whole
 * ladder, each level with what it allows. `md` stands beside a `Select` and a
 * `Button`; `sm` sits in a row.
 */
export function AiAccessLevelPicker<L extends string>({
  levels,
  level,
  onChange,
  label,
  id,
  size = "sm",
  align = "right",
  disabled = false,
  className,
}: {
  levels: AiAccessLevel<L>[];
  level: L;
  onChange: (level: L) => void;
  /** What the button sets, read before its value: "Finance access for Ada". */
  label: string;
  id?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
  disabled?: boolean;
  className?: string;
}) {
  const current = levelOf(levels, level);
  const optionId = React.useId();
  return (
    <Menu
      align={align}
      width={300}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          id={id}
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={`${label}: ${current.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          className={clsx(
            "inline-flex items-center gap-2 rounded-lg border bg-white font-medium text-slate-700 shadow-sm transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            "disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-900 dark:text-slate-200",
            size === "md" ? "h-10 px-3 text-sm" : "h-8 px-2.5 text-xs",
            open
              ? "border-indigo-400 dark:border-indigo-500"
              : "border-slate-200 enabled:hover:border-slate-300 dark:border-slate-700 dark:enabled:hover:border-slate-600",
            className,
          )}
        >
          <span className={clsx("flex shrink-0", current.iconColor)}>{current.icon}</span>
          <span className="min-w-0 flex-1 truncate text-left">{current.label}</span>
          <ChevronDown
            size={14}
            className={clsx(
              "shrink-0 text-slate-400 transition-transform dark:text-slate-500",
              open && "rotate-180",
            )}
          />
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-0.5">
          {levels.map((option) => {
            const active = option.value === level;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                aria-labelledby={`${optionId}-${option.value}`}
                aria-describedby={`${optionId}-${option.value}-hint`}
                onClick={() => {
                  close();
                  if (!active) onChange(option.value);
                }}
                className={clsx(
                  "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800",
                )}
              >
                <span
                  className={clsx(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    option.iconWrap,
                  )}
                >
                  {option.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      id={`${optionId}-${option.value}`}
                      className={clsx(
                        "text-sm font-medium",
                        active
                          ? "text-indigo-700 dark:text-indigo-300"
                          : "text-slate-900 dark:text-slate-100",
                      )}
                    >
                      {option.label}
                    </span>
                    {active && <Check size={13} className="text-indigo-600 dark:text-indigo-300" />}
                  </span>
                  <span
                    id={`${optionId}-${option.value}-hint`}
                    className="mt-0.5 block text-xs leading-5 text-slate-500 dark:text-slate-400"
                  >
                    {option.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Menu>
  );
}

/** A level as plain information, for a Member who can see it but not change it. */
function AiAccessLevelBadge<L extends string>({
  levels,
  level,
}: {
  levels: AiAccessLevel<L>[];
  level: L;
}) {
  const current = levelOf(levels, level);
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-lg bg-slate-50 px-2.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/50 dark:text-slate-200 dark:ring-slate-700">
      <span className={clsx("flex shrink-0", current.iconColor)}>{current.icon}</span>
      {current.label}
    </span>
  );
}

/** A quiet line across the card, in place of a control the viewer has no use for. */
function CardNote({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:bg-slate-800/30 dark:text-slate-400">
      <span className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500">{icon}</span>
      <span>{children}</span>
    </p>
  );
}

function CardEmpty({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-t border-slate-100 px-6 py-12 text-center dark:border-slate-800">
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        {icon}
      </span>
      <div className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">{title}</div>
      {children}
    </div>
  );
}

/**
 * Who holds which level, and — for owners and admins — the way to grant,
 * change and revoke it. The page owns the data and the writes: `onAdd` throws
 * to have its error shown under the form, and `onChangeLevel` / `onRevoke`
 * update the page's grants optimistically and roll back themselves.
 */
export function AiAccessGrantsCard<L extends string, G extends AiAccessGrant<L>>({
  company,
  section,
  levels,
  grants,
  candidates,
  loadError,
  onRetry,
  canManage,
  readOnlyNote,
  emptyHint,
  onAdd,
  onChangeLevel,
  onRevoke,
}: {
  company: Company;
  /** The section in prose, lowercase: "finance" reads "Every AI Employee has finance access". */
  section: string;
  levels: AiAccessLevel<L>[];
  /** Null until the first load settles. */
  grants: G[] | null;
  /** Every AI Employee in the company, granted or not. */
  candidates: AiAccessCandidate[];
  loadError: string | null;
  onRetry: () => Promise<void>;
  canManage: boolean;
  /** Shown to a Member who can see the grants but not change them. */
  readOnlyNote: React.ReactNode;
  /** Under the empty state, for someone who can grant: where to start. */
  emptyHint: string;
  onAdd: (employeeId: string, level: L) => Promise<void>;
  onChangeLevel: (grant: G, level: L) => void;
  onRevoke: (grant: G) => void;
}) {
  const [pickEmployee, setPickEmployee] = React.useState("");
  const [pickLevel, setPickLevel] = React.useState<L>(levels[0].value);
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const formId = React.useId();
  const headingId = React.useId();

  // Who is left to grant, read from the grants on screen rather than each
  // candidate's `alreadyGranted`: a revoke is optimistic, so the roster is a
  // load behind until the next refetch, and a revoked employee would not be
  // offered again.
  const grantedIds = new Set((grants ?? []).map((grant) => grant.employeeId));
  const ungranted = candidates.filter((candidate) => !grantedIds.has(candidate.id));
  const loading = grants === null && !loadError;

  async function add() {
    if (!pickEmployee) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAdd(pickEmployee, pickLevel);
      setPickEmployee("");
      setPickLevel(levels[0].value);
    } catch (err) {
      setAddError(errorMessage(err, `Could not grant ${section} access`));
    } finally {
      setAdding(false);
    }
  }

  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  // Owners and admins get the form while it has someone to offer (or before
  // the roster arrives); a page with nobody left to grant says so instead of
  // drawing a form that can only sit there disabled.
  let addArea: React.ReactNode = null;
  if (!canManage) {
    addArea = <CardNote icon={<Lock size={13} />}>{readOnlyNote}</CardNote>;
  } else if (loadError || (!loading && candidates.length === 0)) {
    addArea = null;
  } else if (!loading && ungranted.length === 0) {
    addArea = (
      <CardNote icon={<CircleCheck size={13} />}>
        Every AI Employee has {section} access. Change a level or revoke access below.
      </CardNote>
    );
  } else {
    addArea = (
      <form
        className="border-t border-slate-100 bg-slate-50/70 px-5 py-4 dark:border-slate-800 dark:bg-slate-800/30"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        {/* One row once the card is wide enough, kept to a form's width on a
            wide screen; until then the employee takes a row of its own and the
            level shares the next with the button. */}
        <div className="flex flex-wrap items-end gap-3 lg:max-w-3xl">
          <div className="min-w-0 basis-full lg:flex-1 lg:basis-0">
            <label
              htmlFor={`${formId}-employee`}
              className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              AI Employee
            </label>
            <Select
              id={`${formId}-employee`}
              aria-label="AI Employee"
              value={pickEmployee}
              onChange={(event) => setPickEmployee(event.target.value)}
              disabled={loading}
            >
              <option value="">Choose an AI Employee…</option>
              {ungranted.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} &mdash; {candidate.role}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0 flex-1 lg:w-52 lg:flex-none">
            <label
              htmlFor={`${formId}-level`}
              className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              Access level
            </label>
            <AiAccessLevelPicker
              id={`${formId}-level`}
              levels={levels}
              level={pickLevel}
              onChange={setPickLevel}
              label="Access level"
              size="md"
              align="left"
              disabled={loading}
              className="w-full"
            />
          </div>
          <Button type="submit" loading={adding} disabled={!pickEmployee} className="shrink-0">
            <UserPlus size={15} />
            Grant access
          </Button>
        </div>
        <FormError message={addError} className="mt-3" />
      </form>
    );
  }

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <div className="flex flex-col items-start gap-3 border-t border-slate-100 p-5 dark:border-slate-800">
        <FormError message={loadError} className="w-full" />
        <Button variant="secondary" size="sm" onClick={() => void retry()} loading={retrying}>
          Try again
        </Button>
      </div>
    );
  } else if (grants === null) {
    body = (
      <div className="flex h-32 items-center justify-center border-t border-slate-100 dark:border-slate-800">
        <Spinner size={18} />
      </div>
    );
  } else if (candidates.length === 0 && grants.length === 0) {
    body = (
      <CardEmpty icon={<Bot size={18} />} title="No AI Employees yet">
        <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
          Hire an AI Employee, then come back here to give it {section} access.
        </p>
        {canManage && (
          <Link
            to={`/c/${company.slug}/employees/new`}
            className={buttonClassName({ size: "sm", className: "mt-4" })}
          >
            Hire an AI Employee
          </Link>
        )}
      </CardEmpty>
    );
  } else if (grants.length === 0) {
    body = (
      <CardEmpty icon={<Users size={18} />} title={`No AI Employees have ${section} access yet`}>
        {canManage && (
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500 dark:text-slate-400">
            {emptyHint}
          </p>
        )}
      </CardEmpty>
    );
  } else {
    body = (
      <>
        <div
          aria-hidden
          className={clsx(
            "hidden border-t border-slate-100 px-5 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400",
            GRANT_COLUMNS,
          )}
        >
          <span>AI Employee</span>
          <span>Access</span>
          <span>Granted</span>
          <span />
        </div>
        <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              company={company}
              section={section}
              levels={levels}
              grant={grant}
              canManage={canManage}
              onChangeLevel={(level) => onChangeLevel(grant, level)}
              onRevoke={() => onRevoke(grant)}
            />
          ))}
        </ul>
      </>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-baseline justify-between gap-3 px-5 py-4">
        <h2 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          AI Employees with access
        </h2>
        {!loadError && grants && grants.length > 0 && (
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {grants.length} of {Math.max(candidates.length, grants.length)}
          </span>
        )}
      </div>
      {addArea}
      {body}
    </section>
  );
}

/**
 * From `lg` the grants read as a table — AI Employee, access, when it was
 * granted, actions — so the page can use the whole pane like the rest of the
 * app without stranding each row's controls at the far edge. Narrower, a row
 * is the employee with its controls beside it, or under it on a phone.
 */
const GRANT_COLUMNS =
  "lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(11rem,1fr)_minmax(7rem,1fr)_4.5rem] lg:items-center lg:gap-4";

function grantedOn(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function GrantRow<L extends string>({
  company,
  section,
  levels,
  grant,
  canManage,
  onChangeLevel,
  onRevoke,
}: {
  company: Company;
  section: string;
  levels: AiAccessLevel<L>[];
  grant: AiAccessGrant<L>;
  canManage: boolean;
  onChangeLevel: (level: L) => void;
  onRevoke: () => void;
}) {
  const name = grant.employee?.name ?? "Unknown employee";
  return (
    <li
      className={clsx(
        "flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-3",
        GRANT_COLUMNS,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar
          name={name}
          kind="ai"
          size="md"
          src={
            grant.employee
              ? employeeAvatarUrl(company.id, grant.employee.id, grant.employee.avatarKey)
              : null
          }
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {name}
          </div>
          {grant.employee?.role && (
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
              {grant.employee.role}
            </div>
          )}
        </div>
      </div>
      {/* On a phone the controls drop under the name, lined up with it; from
          `lg` each of them is a cell of the row's table. */}
      <div className="flex items-center gap-1 pl-11 sm:pl-0 lg:contents">
        {canManage ? (
          <AiAccessLevelPicker
            levels={levels}
            level={grant.accessLevel}
            onChange={onChangeLevel}
            label={`${capitalize(section)} access for ${name}`}
            className="min-w-0 flex-1 sm:w-44 sm:flex-none"
          />
        ) : (
          <span className="flex">
            <AiAccessLevelBadge levels={levels} level={grant.accessLevel} />
          </span>
        )}
        <span className="hidden text-xs tabular-nums text-slate-500 dark:text-slate-400 lg:block">
          {grantedOn(grant.createdAt)}
        </span>
        <div className="flex items-center gap-1 lg:justify-end">
          {grant.employee && (
            <Link
              to={`/c/${company.slug}/employees/${grant.employee.slug}/chat`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label={`Chat with ${name}`}
              title={`Chat with ${name}`}
            >
              <MessageSquare size={15} />
            </Link>
          )}
          {canManage && (
            <button
              type="button"
              onClick={onRevoke}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
              aria-label={`Revoke ${name}'s ${section} access`}
              title={`Revoke ${section} access`}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
