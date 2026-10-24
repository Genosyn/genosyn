import React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Plus, Users, Wrench } from "lucide-react";
import { api, Company, Employee, SkillWithMeta } from "../lib/api";
import { newSkillPath } from "../lib/newItemPath";
import { ContextualLayout, sidebarLinkClassName } from "../components/AppShell";
import { RailIconButton, SectionRailHeader, railHeadingClassName } from "../components/SectionRail";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Skills section shell — every playbook in the company, in one place. Skills
 * belong to an AI employee, and until now that was the only way to reach
 * them: "what do we know how to do?" meant opening each employee in turn. The
 * sidebar keeps the roster as a *filter* rather than a hierarchy, so the whole
 * company's playbook library is the default view.
 *
 * The skill list is loaded once here and shared with both children, because
 * the detail page resolves its skill out of it (`:empSlug/:skillSlug` — a
 * skill slug is only unique per employee, so it takes both segments).
 */
export default function SkillsLayout({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [skills, setSkills] = React.useState<SkillWithMeta[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      const [rows, roster] = await Promise.all([
        api.get<SkillWithMeta[]>(`/api/companies/${company.id}/skills`),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      ]);
      setSkills(rows);
      setEmployees(roster);
    } catch {
      setSkills([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  useLiveRefetch("skill", refresh);

  const ctx = React.useMemo<SkillsContext>(
    () => ({ skills: skills ?? [], employees, loading: skills === null, refresh }),
    [skills, employees, refresh],
  );

  return (
    <ContextualLayout
      sidebar={
        <Sidebar
          company={company}
          skills={skills}
          employees={employees}
          onNew={(href) => navigate(href)}
        />
      }
    >
      <Outlet context={ctx} />
    </ContextualLayout>
  );
}

export type SkillsContext = {
  skills: SkillWithMeta[];
  /** Full roster — a skill can be created for an employee that has none yet. */
  employees: Employee[];
  loading: boolean;
  refresh: () => Promise<void>;
};

function Sidebar({
  company,
  skills,
  employees,
  onNew,
}: {
  company: Company;
  skills: SkillWithMeta[] | null;
  employees: Employee[];
  onNew: (href: string) => void;
}) {
  const location = useLocation();
  const base = `/c/${company.slug}/skills`;
  const activeEmployee = new URLSearchParams(location.search).get("employee");
  const onIndex = location.pathname === base;

  const countFor = (slug: string) =>
    (skills ?? []).filter((s) => s.employee?.slug === slug).length;

  // Only employees that actually own skills earn a filter row — a roster of
  // twenty with one skill between them would bury the thing you came for.
  const withSkills = employees.filter((e) => countFor(e.slug) > 0);

  return (
    <div className="flex h-full flex-col">
      <SectionRailHeader
        section="skills"
        label="Skills"
        actions={
          <RailIconButton
            label="New skill"
            onClick={() =>
              onNew(newSkillPath(company.slug, { employee: onIndex ? activeEmployee : null }))
            }
          >
            <Plus size={16} />
          </RailIconButton>
        }
      />
      <div className="flex-1 overflow-y-auto p-2">
        <NavLink
          to={base}
          end
          className={
            sidebarLinkClassName(onIndex && !activeEmployee)
          }
        >
          <Wrench size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All skills</span>
          {skills !== null && (
            <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
              {skills.length}
            </span>
          )}
        </NavLink>

        {withSkills.length > 0 && (
          <>
            <div className={`flex items-center gap-1.5 pb-1 pl-2.5 pt-4 ${railHeadingClassName}`}>
              <Users size={13} aria-hidden="true" /> Known by
            </div>
            {withSkills.map((e) => {
              const active = onIndex && activeEmployee === e.slug;
              return (
                <NavLink
                  key={e.id}
                  to={`${base}?employee=${e.slug}`}
                  className={
                    sidebarLinkClassName(active)
                  }
                >
                  <Avatar
                    name={e.name}
                    src={employeeAvatarUrl(company.id, e.id, e.avatarKey)}
                    kind="ai"
                    size="xs"
                  />
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {countFor(e.slug)}
                  </span>
                </NavLink>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
