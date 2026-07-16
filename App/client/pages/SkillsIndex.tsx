import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { Search, Wrench } from "lucide-react";
import { Company, SkillWithMeta } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { SkillsContext } from "./SkillsLayout";

/**
 * Every skill in the company. Filterable by the employee that knows it
 * (`?employee=<slug>`, driven by the sidebar) and by a free-text search over
 * the skill name and its owner — a playbook library gets long, and scanning
 * it by eye stops working somewhere around thirty rows.
 */
export default function SkillsIndex({ company }: { company: Company }) {
  const { skills, loading } = useOutletContext<SkillsContext>();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = React.useState("");
  const navigate = useNavigate();

  const employeeSlug = searchParams.get("employee");
  const employee = skills.find((s) => s.employee?.slug === employeeSlug)?.employee ?? null;

  const scoped = employeeSlug
    ? skills.filter((s) => s.employee?.slug === employeeSlug)
    : skills;

  const q = query.trim().toLowerCase();
  const shown = q
    ? scoped.filter((s) =>
        [s.name, s.slug, s.employee?.name ?? ""].some((f) => f.toLowerCase().includes(q)),
      )
    : scoped;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <Breadcrumbs
        items={[
          { label: "Skills", to: `/c/${company.slug}/skills` },
          ...(employee ? [{ label: employee.name }] : []),
        ]}
      />
      <TopBar
        title={employee ? `${employee.name}'s skills` : "Skills"}
        right={
          <Button onClick={() => navigate(`/c/${company.slug}/skills/new`)}>New skill</Button>
        }
      />

      {loading ? (
        <Spinner />
      ) : skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="A skill is a markdown playbook an AI employee follows — how you qualify a lead, how you close the books, how you triage a bug report."
          action={
            <Button onClick={() => navigate(`/c/${company.slug}/skills/new`)}>New skill</Button>
          }
        />
      ) : (
        <>
          <div className="relative mb-4">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills by name or employee…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-sm text-slate-700 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
          </div>

          {shown.length === 0 ? (
            <EmptyState title="Nothing here" description="No skills match this search." />
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
              {/* Column headers are desktop-only; each row restates its own
                  labels once the grid collapses. */}
              <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 md:grid dark:border-slate-800 dark:text-slate-500">
                <div>Skill</div>
                <div>Known by</div>
                <div>Created</div>
                <div className="w-8" />
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {shown.map((s) => (
                  <SkillRow key={s.id} company={company} skill={s} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SkillRow({ company, skill: s }: { company: Company; skill: SkillWithMeta }) {
  const to = s.employee ? `/c/${company.slug}/skills/${s.employee.slug}/${s.slug}` : null;

  return (
    <li className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center md:gap-4 dark:hover:bg-slate-900">
      <div className="min-w-0">
        {to ? (
          <Link
            to={to}
            className="truncate font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
          >
            {s.name}
          </Link>
        ) : (
          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
            {s.name}
          </span>
        )}
        <div className="mt-0.5 truncate text-xs text-slate-400 dark:text-slate-500">@{s.slug}</div>
      </div>

      <div className="min-w-0">
        {s.employee ? (
          <Link
            to={`/c/${company.slug}/employees/${s.employee.slug}`}
            className="flex min-w-0 items-center gap-2 text-sm text-slate-600 hover:text-indigo-600 dark:text-slate-300 dark:hover:text-indigo-400"
          >
            <Avatar
              name={s.employee.name}
              src={employeeAvatarUrl(company.id, s.employee.id, s.employee.avatarKey)}
              kind="ai"
              size="xs"
            />
            <span className="truncate">{s.employee.name}</span>
          </Link>
        ) : (
          <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
        )}
      </div>

      <div className="min-w-0">
        <span
          className="truncate text-xs text-slate-400 tabular-nums dark:text-slate-500"
          title={new Date(s.createdAt).toLocaleString()}
        >
          {new Date(s.createdAt).toLocaleDateString()}
        </span>
      </div>

      <div className="flex shrink-0 items-center justify-self-start md:justify-self-end">
        {to && (
          <Link
            to={to}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Open skill"
            aria-label={`Open ${s.name}`}
          >
            <Wrench size={14} />
          </Link>
        )}
      </div>
    </li>
  );
}
