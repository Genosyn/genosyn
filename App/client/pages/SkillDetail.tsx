import React from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { api, Company, SkillWithMeta } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { ToolsetPicker } from "../components/ToolsetPicker";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Spinner } from "../components/ui/Spinner";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { SkillsContext } from "./SkillsLayout";
import { ResourceTagPicker } from "../components/TagPicker";

/**
 * One skill, in full: the playbook itself, and who knows it.
 *
 * Addressed by `:empSlug/:skillSlug` rather than a bare slug because a skill
 * slug is only unique within its employee — two employees may both have a
 * `weekly-report`.
 */

type Tab = "playbook" | "settings";
const TABS: Array<[Tab, string]> = [
  ["playbook", "Playbook"],
  ["settings", "Settings"],
];

export default function SkillDetail({ company }: { company: Company }) {
  const { empSlug, skillSlug } = useParams();
  const { skills, loading, refresh } = useOutletContext<SkillsContext>();
  const [searchParams, setSearchParams] = useSearchParams();

  const skill =
    skills.find((s) => s.employee?.slug === empSlug && s.slug === skillSlug) ?? null;

  const tabParam = searchParams.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.some(([t]) => t === tabParam) ? tabParam : "playbook";

  function setTab(next: Tab) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "playbook") p.delete("tab");
        else p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Spinner />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Breadcrumbs items={[{ label: "Skills", to: `/c/${company.slug}/skills` }]} />
        <div className="mt-4">
          <EmptyState
            title="Skill not found"
            description="It may have been deleted, or renamed to a different address."
            action={
              <Link to={`/c/${company.slug}/skills`}>
                <Button variant="secondary">Back to skills</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const emp = skill.employee;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Breadcrumbs
        items={[
          { label: "Skills", to: `/c/${company.slug}/skills` },
          ...(emp ? [{ label: emp.name, to: `/c/${company.slug}/skills?employee=${emp.slug}` }] : []),
          { label: skill.name },
        ]}
      />

      <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {skill.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
            <span className="font-mono text-xs">@{skill.slug}</span>
            {emp && (
              <>
                <span aria-hidden="true">·</span>
                <Link
                  to={`/c/${company.slug}/employees/${emp.slug}`}
                  className="flex min-w-0 items-center gap-1.5 hover:text-indigo-600 dark:hover:text-indigo-400"
                >
                  <Avatar
                    name={emp.name}
                    src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey)}
                    kind="ai"
                    size="xs"
                  />
                  <span className="truncate">{emp.name}</span>
                </Link>
              </>
            )}
          </div>
          <div className="mt-3 max-w-lg">
            <ResourceTagPicker
              companyId={company.id}
              resourceType="skill"
              resourceId={skill.id}
              value={skill.tags ?? []}
              onSaved={refresh}
            />
          </div>
        </div>
      </div>

      <div className="mb-5 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition " +
              (tab === key
                ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "playbook" && <PlaybookTab company={company} skill={skill} />}
      {tab === "settings" && (
        <SettingsTab company={company} skill={skill} onSaved={refresh} />
      )}
    </div>
  );
}

// ────────────────────────────── Playbook ────────────────────────────────

/**
 * The markdown playbook the employee folds into its prompt. Round-trips
 * against `Skill.body` via `/skills/:sid/readme`.
 */
function PlaybookTab({ company, skill }: { company: Company; skill: SkillWithMeta }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/skills/${skill.id}/readme`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((err) => toast((err as Error).message, "error"));
  }, [company.id, skill.id, toast]);

  const save = React.useCallback(async () => {
    if (content === null) return;
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/skills/${skill.id}/readme`, { content });
      setSaved(content);
      toast("Skill saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [company.id, skill.id, content, toast]);

  if (content === null) return <Spinner />;
  const dirty = content !== saved;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          The procedure this employee follows for {skill.name.toLowerCase()}. Folded
          into their prompt alongside their Soul.
        </p>
        <MarkdownEditor value={content} onChange={setContent} rows={18} onSave={save} />
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save skill"}
          </Button>
          {dirty ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">Unsaved changes</span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-slate-500">⌘S to save</span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ────────────────────────────── Settings ────────────────────────────────

function SettingsTab({
  company,
  skill,
  onSaved,
}: {
  company: Company;
  skill: SkillWithMeta;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = React.useState(skill.name);
  const [toolset, setToolset] = React.useState<string[]>(skill.toolset ?? []);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/companies/${company.id}/skills/${skill.id}`, {
        name: name.trim(),
        toolset,
      });
      await onSaved();
      toast("Skill saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The address stays <code className="font-mono">@{skill.slug}</code> when you
            rename — links to this skill keep working.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100">Tools</h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Employees see a working set of tools and look the rest up as they need them.
              Tools you name here are loaded up-front whenever this skill applies, so the
              employee never has to search for them. This doesn&apos;t grant access — Grants
              are still checked when the tool runs.
            </p>
          </div>
          <ToolsetPicker companyId={company.id} value={toolset} onChange={setToolset} />
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving || !name.trim() || name.trim() === skill.name}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <Card className="border-rose-200 dark:border-rose-500/30">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Delete this skill
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The playbook goes away, and the employee stops applying it.
            </div>
          </div>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await dialog.confirm({
                title: `Delete skill "${skill.name}"?`,
                message:
                  "The playbook will be removed, and this employee will stop applying it.",
                confirmLabel: "Delete skill",
                variant: "danger",
              });
              if (!ok) return;
              try {
                await api.del(`/api/companies/${company.id}/skills/${skill.id}`);
                await onSaved();
                navigate(`/c/${company.slug}/skills`, { replace: true });
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
