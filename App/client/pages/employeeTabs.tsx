import React from "react";
import { NavLink, Outlet, useNavigate, useOutletContext } from "react-router-dom";
import {
  BrainCircuit,
  Brain,
  Camera,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  Globe,
  Loader2,
  BookText,
  Plug,
  Plus,
  Sparkles,
  Trash2,
  Unplug,
  UserRound,
  X,
} from "lucide-react";
import {
  api,
  AIModel,
  AuthMode,
  Company,
  Employee,
  Provider,
  JournalEntry as JournalEntryT,
  JournalKind,
  MemoryItem,
  McpServer,
  McpTransport,
  Team,
} from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * The individual employee sub-pages. Previously these were tabs on
 * EmployeeDetail.tsx — now each is a route rendered inside EmployeeLayout
 * via <Outlet context>. The logic inside each component is mostly a
 * straight lift of the old tab bodies.
 */

function useCtx(): EmployeeOutletCtx {
  return useOutletContext<EmployeeOutletCtx>();
}

/**
 * SoulCard — the Soul editor. Used inline on the employee Settings page
 * (no longer has its own sidebar entry; Soul sits with the rest of the
 * per-employee settings). Round-trips the Soul body against
 * `AIEmployee.soulBody` via `/api/.../employees/:eid/soul`.
 */
function SoulCard({ company, emp }: { company: Company; emp: Employee }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/employees/${emp.id}/soul`)
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      });
  }, [company.id, emp.id]);

  const dirty = content !== null && saved !== null && content !== saved;

  const save = React.useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, { content });
      setSaved(content);
      toast("Soul saved", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [company.id, emp.id, content, saving, toast]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">Soul</span>
              {dirty && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Unsaved
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {emp.name}&apos;s constitution — the markdown {emp.name} reads
              before every task.
            </div>
          </div>
        </div>
        {content === null ? (
          <Spinner />
        ) : (
          <>
            <MarkdownEditor value={content} onChange={setContent} rows={16} onSave={save} />
            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save Soul"}
              </Button>
              <span className="text-xs text-slate-400 dark:text-slate-500">⌘S to save</span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- Model (Settings) tab ----------

const PROVIDER_DEFAULTS: Record<
  Provider,
  { label: string; model: string; authMode: AuthMode }
> = {
  anthropic: { label: "Anthropic (Claude)", model: "claude-opus-4-6", authMode: "apikey" },
  openai: { label: "OpenAI (GPT)", model: "gpt-4o", authMode: "apikey" },
  custom: { label: "Custom OpenAI-compatible endpoint", model: "", authMode: "customEndpoint" },
};

/**
 * Employee Settings. Soul + Model used to share one scroll-heavy page; now
 * each is its own sub-route with a small side nav. New per-employee setting
 * surfaces (permissions, memory retention, notifications) slot in as extra
 * sidebar entries rather than another stacked card.
 */
export function SettingsPage() {
  return (
    <>
      <TopBar title="Settings" />
      <div className="flex gap-6">
        <SettingsSideNav />
        <div className="min-w-0 flex-1">
          <Outlet context={useCtx()} />
        </div>
      </div>
    </>
  );
}

function SettingsSideNav() {
  return (
    <nav className="w-44 shrink-0">
      <ul className="flex flex-col gap-0.5">
        <SettingsNavItem to="general" icon={<UserRound size={14} />} label="General" />
        <SettingsNavItem to="soul" icon={<Sparkles size={14} />} label="Soul" />
        <SettingsNavItem to="model" icon={<BrainCircuit size={14} />} label="Model" />
        <SettingsNavItem to="browser" icon={<Globe size={14} />} label="Browser" />
      </ul>
    </nav>
  );
}

function SettingsNavItem({
  to,
  icon,
  label,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <NavLink
        to={to}
        className={({ isActive }) =>
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm " +
          (isActive
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800")
        }
      >
        {icon}
        {label}
      </NavLink>
    </li>
  );
}

export function SoulSettingsPage() {
  const { company, emp } = useCtx();
  return <SoulCard company={company} emp={emp} />;
}

/**
 * General settings for an employee — name, role, slug, and profile picture.
 * Slug edits rename the on-disk employee directory (so credential paths
 * stay stable) and bounce the URL once the PATCH lands. The avatar uploader
 * round-trips through the multipart POST on `/employees/:eid/avatar`.
 */
export function GeneralSettingsPage() {
  const { company, emp } = useCtx();
  return (
    <div className="flex flex-col gap-4">
      <EmployeeAvatarCard company={company} emp={emp} />
      <EmployeeBasicsCard company={company} emp={emp} />
      <EmployeeOrgCard company={company} emp={emp} />
    </div>
  );
}

export function BrowserSettingsPage() {
  const { company, emp } = useCtx();
  return <EmployeeBrowserAccessCard company={company} emp={emp} />;
}

function EmployeeOrgCard({
  company,
  emp,
}: {
  company: Company;
  emp: Employee;
}) {
  const [teams, setTeams] = React.useState<Team[] | null>(null);
  const [peers, setPeers] = React.useState<Employee[] | null>(null);
  const [teamId, setTeamId] = React.useState<string>(emp.teamId ?? "");
  const [reportsTo, setReportsTo] = React.useState<string>(
    emp.reportsToEmployeeId ?? "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setTeamId(emp.teamId ?? "");
    setReportsTo(emp.reportsToEmployeeId ?? "");
  }, [emp.id, emp.teamId, emp.reportsToEmployeeId]);

  React.useEffect(() => {
    api
      .get<Team[]>(`/api/companies/${company.id}/teams`)
      .then((list) => setTeams(list.filter((t) => !t.archivedAt)))
      .catch(() => setTeams([]));
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => setPeers(list.filter((e) => e.id !== emp.id)))
      .catch(() => setPeers([]));
  }, [company.id, emp.id]);

  const dirty =
    (teamId || null) !== (emp.teamId ?? null) ||
    (reportsTo || null) !== (emp.reportsToEmployeeId ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || saving) return;
    setError(null);
    setSaving(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        {
          teamId: teamId || null,
          reportsToEmployeeId: reportsTo || null,
        },
      );
      toast("Org chart updated", "success");
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Org chart
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            The team this employee belongs to and who they report to. Manager
            is used by the <code className="font-mono">create_handoff</code>{" "}
            <code className="font-mono">toManager: true</code> shortcut.
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <FormError message={error} />
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Team
            </span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={!teams}
            >
              <option value="">— No team —</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Reports to
            </span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              value={reportsTo}
              onChange={(e) => setReportsTo(e.target.value)}
              disabled={!peers}
            >
              <option value="">— No manager —</option>
              {(peers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function EmployeeAvatarCard({ company, emp }: { company: Company; emp: Employee }) {
  const [avatarKey, setAvatarKey] = React.useState<string | null>(
    emp.avatarKey ?? null,
  );
  const [uploading, setUploading] = React.useState(false);
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
      const res = await fetch(
        `/api/companies/${company.id}/employees/${emp.id}/avatar`,
        { method: "POST", credentials: "same-origin", body: fd },
      );
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
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}/avatar`);
      setAvatarKey(null);
    } catch (err) {
      setError((err as Error).message);
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
            Shown in the sidebar, employee list, and workspace chat. PNG, JPEG,
            GIF, or WebP up to 5&nbsp;MB.
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
          <div className="flex flex-wrap items-center gap-2">
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
              disabled={uploading}
            >
              <Camera size={12} /> {uploading ? "Uploading…" : "Upload new"}
            </Button>
            {avatarKey && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={uploading}>
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
  const [name, setName] = React.useState(emp.name);
  const [role, setRole] = React.useState(emp.role);
  const [slug, setSlug] = React.useState(emp.slug);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

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
      toast("Employee updated", "success");
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

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Basics
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Renaming the slug updates the URL for this employee and renames its
            directory under{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              data/companies/{company.slug}/employees/
            </code>
            .
          </div>
        </div>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <FormError message={error} />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Role" value={role} onChange={(e) => setRole(e.target.value)} />
          <div>
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onBlur={() => setSlug((s) => normalizeSlug(s))}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              title="Lowercase letters, digits, and single dashes"
              required
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              URL:{" "}
              <code className="font-mono">
                /c/{company.slug}/employees/{normalizedSlug || "…"}
              </code>
            </p>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
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
 * Per-employee toggle for the built-in `browser` MCP server, plus the two
 * shaping settings: an allow list of host globs and an approval gate that
 * blocks form submits until a human says yes. Off by default — operator
 * opts in per employee, then narrows further with the allow list /
 * approval mode.
 */
function EmployeeBrowserAccessCard({
  company,
  emp,
}: {
  company: Company;
  emp: Employee;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(!!emp.browserEnabled);
  const [allowedHosts, setAllowedHosts] = React.useState<string>(emp.browserAllowedHosts ?? "");
  const [approval, setApproval] = React.useState<boolean>(!!emp.browserApprovalRequired);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [savingApproval, setSavingApproval] = React.useState(false);
  const [savingHosts, setSavingHosts] = React.useState(false);
  const { toast } = useToast();

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
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserEnabled: next },
      );
      toast(next ? "Browser access enabled" : "Browser access disabled", "success");
      window.dispatchEvent(new CustomEvent("genosyn:employee-updated"));
    } catch (err) {
      setEnabled(!next);
      toast((err as Error).message || "Could not update browser access", "error");
    } finally {
      setSavingToggle(false);
    }
  }

  async function toggleApproval(next: boolean) {
    if (savingApproval) return;
    setApproval(next);
    setSavingApproval(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserApprovalRequired: next },
      );
      toast(
        next ? "Browser submits will require approval" : "Approval gate disabled",
        "success",
      );
    } catch (err) {
      setApproval(!next);
      toast((err as Error).message || "Could not update approval mode", "error");
    } finally {
      setSavingApproval(false);
    }
  }

  async function saveHosts() {
    if (savingHosts) return;
    setSavingHosts(true);
    try {
      await api.patch<Employee>(
        `/api/companies/${company.id}/employees/${emp.id}`,
        { browserAllowedHosts: allowedHosts },
      );
      toast("Allow list saved", "success");
    } catch (err) {
      toast((err as Error).message || "Could not save allow list", "error");
    } finally {
      setSavingHosts(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Globe size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Browser access
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Wire a headless Chromium into this employee&apos;s tools. Adds{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_open
                </code>
                ,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_click
                </code>
                ,{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  browser_fill
                </code>
                , and screenshot tools so the employee can read and interact
                with web pages. Off by default — narrow further with the
                allow list and approval mode below.
              </p>
            </div>
          </div>
          <label className="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={enabled}
              disabled={savingToggle}
              onChange={(e) => toggle(e.target.checked)}
            />
            <div className="h-5 w-9 rounded-full bg-slate-200 transition peer-checked:bg-indigo-500 peer-disabled:opacity-50 dark:bg-slate-700 dark:peer-checked:bg-indigo-500" />
            <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
          </label>
        </div>

        {enabled && (
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                Allow list
              </label>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                One host pattern per line.{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  github.com
                </code>{" "}
                allows the domain and every subdomain;{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  mail.google.com
                </code>{" "}
                pins one host (and its subdomains). Lines starting with{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  #
                </code>{" "}
                are comments. Leave blank for no restriction.
              </p>
              <textarea
                rows={4}
                value={allowedHosts}
                onChange={(e) => setAllowedHosts(e.target.value)}
                placeholder="# Examples:&#10;mail.google.com&#10;github.com"
                className="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="secondary"
                  disabled={!hostsDirty || savingHosts}
                  onClick={saveHosts}
                >
                  {savingHosts ? "Saving…" : "Save allow list"}
                </Button>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 border-t border-slate-100 pt-3 dark:border-slate-800">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  Require approval for form submits
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Calls to{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    browser_submit
                  </code>{" "}
                  queue an Approval row instead of firing immediately. The
                  employee resumes via{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    browser_resume
                  </code>{" "}
                  once a human approves.
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={approval}
                  disabled={savingApproval}
                  onChange={(e) => toggleApproval(e.target.checked)}
                />
                <div className="h-5 w-9 rounded-full bg-slate-200 transition peer-checked:bg-indigo-500 peer-disabled:opacity-50 dark:bg-slate-700 dark:peer-checked:bg-indigo-500" />
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
              </label>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function ModelSettingsPage() {
  const { company, emp } = useCtx();
  return <EmployeeModelSection company={company} emp={emp} />;
}

/**
 * Renders the full per-employee model surface. An employee can register
 * several models and keep exactly one active; this lists them, lets the
 * operator add more, switch the active one, sign each in, and reconfigure or
 * remove them. Exported so the onboarding wizard can drop it in as a step
 * without duplicating the state machine.
 */
export function EmployeeModelSection({ company, emp }: { company: Company; emp: Employee }) {
  const [models, setModels] = React.useState<AIModel[] | undefined>(undefined);
  const [adding, setAdding] = React.useState(false);

  const reload = React.useCallback(async () => {
    const list = await api.get<AIModel[]>(
      `/api/companies/${company.id}/employees/${emp.id}/models`,
    );
    setModels(list);
  }, [company.id, emp.id]);

  React.useEffect(() => {
    reload().catch(() => setModels([]));
  }, [reload]);

  if (models === undefined) return <Spinner />;

  // No models yet — straight to the first-model setup card.
  if (models.length === 0) {
    return <ModelSetup company={company} emp={emp} onSaved={reload} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {emp.name}&apos;s models
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {models.length === 1
              ? "One brain registered. Add another to switch between them any time."
              : `${models.length} brains registered — the active one answers chats and runs routines.`}
          </div>
        </div>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add model
          </Button>
        )}
      </div>

      {adding && (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Add a model
              </div>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              The model you add becomes active right away. You can switch back any time.
            </div>
            <ModelForm
              mode="create"
              initial={{ provider: "anthropic", model: "claude-opus-4-6", authMode: "apikey" }}
              company={company}
              emp={emp}
              onSaved={() => {
                setAdding(false);
                reload();
              }}
              submitLabel="Add model"
            />
          </CardBody>
        </Card>
      )}

      {models.map((m) => (
        <ModelCard key={m.id} company={company} emp={emp} model={m} onChanged={reload} />
      ))}
    </div>
  );
}

function ModelSetup({
  company,
  emp,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  onSaved: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Connect a brain for {emp.name}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Each AI Employee signs into their own provider — pick one and connect it.
          </div>
        </div>
        <ModelForm
          mode="create"
          initial={{ provider: "anthropic", model: "claude-opus-4-6", authMode: "apikey" }}
          company={company}
          emp={emp}
          onSaved={onSaved}
          submitLabel="Continue"
        />
      </CardBody>
    </Card>
  );
}

function ModelForm({
  mode,
  editModelId,
  initial,
  company,
  emp,
  onSaved,
  submitLabel,
}: {
  /** "create" POSTs a new model row; "edit" PUTs an existing one. */
  mode: "create" | "edit";
  /** Required when mode is "edit" — the row being reconfigured. */
  editModelId?: string;
  initial: { provider: Provider; model: string; authMode: AuthMode };
  company: Company;
  emp: Employee;
  onSaved: () => void;
  submitLabel: string;
}) {
  const [provider, setProvider] = React.useState<Provider>(initial.provider);
  const [modelStr, setModelStr] = React.useState(initial.model);
  const [saving, setSaving] = React.useState(false);
  // Custom-endpoint inputs live on the same form so onboarding is one submit.
  const [baseURL, setBaseURL] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const { toast } = useToast();

  const isCustom = provider === "custom";
  const authMode: AuthMode = isCustom ? "customEndpoint" : "apikey";

  const onProvider = (p: Provider) => {
    setProvider(p);
    setModelStr(PROVIDER_DEFAULTS[p].model);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        const base = `/api/companies/${company.id}/employees/${emp.id}/models`;
        try {
          if (isCustom) {
            // Two-call save: create/update the row in customEndpoint mode (the
            // schema requires a non-empty model — the model id satisfies it),
            // then the encrypted endpoint config that flips status to connected.
            const payload = { provider: "custom", model: modelId || "custom", authMode };
            const saved =
              mode === "create"
                ? await api.post<AIModel>(base, payload)
                : await api.put<AIModel>(`${base}/${editModelId}`, payload);
            await api.post(`${base}/${saved.id}/custom-endpoint`, {
              baseURL,
              modelId,
              ...(apiKey ? { apiKey } : {}),
            });
            setApiKey("");
            onSaved();
            return;
          }
          const payload = { provider, model: modelStr, authMode };
          if (mode === "create") {
            await api.post<AIModel>(base, payload);
          } else {
            await api.put<AIModel>(`${base}/${editModelId}`, payload);
          }
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className={isCustom ? "" : "grid gap-3 sm:grid-cols-2"}>
        <Select
          label="Provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value as Provider)}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI (GPT)</option>
          <option value="custom">Custom OpenAI-compatible endpoint</option>
        </Select>
        {!isCustom && (
          <Input
            label="Model"
            value={modelStr}
            onChange={(e) => setModelStr(e.target.value)}
            required
          />
        )}
      </div>
      {isCustom && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Base URL"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder={baseUrlPlaceholder(provider)}
              required
            />
            <Input
              label="Model id"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="qwen2.5-coder:32b"
              required
            />
          </div>
          <Input
            label="API key (optional — most local servers ignore this)"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="leave blank if not needed"
          />
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Point this employee at a self-hosted OpenAI-compatible server —
            Ollama, vLLM, llama.cpp, LM Studio. Base URL + key are stored
            encrypted at rest.
          </div>
        </div>
      )}
      {!isCustom && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {provider === "anthropic"
            ? "Claude via the Anthropic API. Add the API key after saving."
            : "GPT via the OpenAI API. Add the API key after saving."}
        </div>
      )}
      <div>
        <Button
          type="submit"
          disabled={
            saving ||
            (isCustom && (baseURL.trim().length === 0 || modelId.trim().length === 0))
          }
        >
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * One model in the employee's roster: status, an active toggle, the connect
 * panel (API key or custom endpoint), and a reconfigure disclosure. The active
 * model is ringed and badged; any non-active model gets a "Make active" button.
 */
function ModelCard({
  company,
  emp,
  model,
  onChanged,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const connected = model.status === "connected";
  const [activating, setActivating] = React.useState(false);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models`;

  async function activate() {
    setActivating(true);
    try {
      await api.post(`${base}/${model.id}/activate`);
      toast(`${emp.name} now runs on ${model.provider} · ${model.model}`, "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setActivating(false);
    }
  }

  async function disconnect() {
    if (connected) {
      const ok = await dialog.confirm({
        title: `Remove this model?`,
        message: `${emp.name}'s stored credentials for ${model.provider} · ${model.model} will be removed. You can reconnect any time.`,
        confirmLabel: "Remove",
        variant: "danger",
      });
      if (!ok) return;
    }
    try {
      await api.del(`${base}/${model.id}`);
      toast(connected ? "Model removed" : "Removed", "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const subtitle = (() => {
    if (connected) {
      if (model.authMode === "customEndpoint") {
        return model.customEndpointHost
          ? `Pointed at ${model.customEndpointHost}`
          : "Custom endpoint configured";
      }
      return `Authenticated with ${model.apiKeyEnv ?? "API"} key`;
    }
    if (model.authMode === "customEndpoint") {
      return "Enter the server's base URL and model id below to connect.";
    }
    return `No ${model.apiKeyEnv ?? "API"} key on file yet — paste one below to connect.`;
  })();

  return (
    <Card
      className={
        model.isActive ? "ring-1 ring-indigo-300 dark:ring-indigo-500/40" : undefined
      }
    >
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {model.provider} · {model.model}
              </span>
              <StatusBadge connected={connected} />
              {model.isActive && <ActiveBadge />}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {subtitle}
              {model.connectedAt && connected && (
                <> · connected {new Date(model.connectedAt).toLocaleString()}</>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!model.isActive && (
              <Button size="sm" variant="ghost" onClick={activate} disabled={activating}>
                {activating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Make active
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={disconnect}>
              <Unplug size={14} /> {connected ? "Remove" : "Cancel"}
            </Button>
          </div>
        </div>

        {!connected && model.authMode === "apikey" && (
          <ApiKeyPanel company={company} emp={emp} model={model} onSaved={onChanged} />
        )}
        {model.authMode === "customEndpoint" && (
          <CustomEndpointPanel
            company={company}
            emp={emp}
            model={model}
            onSaved={onChanged}
          />
        )}

        {connected && (
          <ContextWindowPanel
            company={company}
            emp={emp}
            model={model}
            onChanged={onChanged}
          />
        )}

        <details className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
          <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">
            Change provider, model, or endpoint
          </summary>
          <div className="mt-3">
            <ModelForm
              mode="edit"
              editModelId={model.id}
              initial={{ provider: model.provider, model: model.model, authMode: model.authMode }}
              company={company}
              emp={emp}
              onSaved={onChanged}
              submitLabel="Save changes"
            />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

/**
 * The model's context window, and the affordances to fix it when we don't know.
 *
 * This sits on the card rather than inside the advanced `<details>` because the
 * number is load-bearing, not trivia: a run budgets against it to decide when to
 * drop older tool results, so while it is unknown a long routine can only
 * discover it has overrun once the provider rejects a turn.
 *
 * Plenty of servers genuinely don't report one — plain Ollama, OpenAI's own API
 * — so "unknown" is a normal resting state, not an error to shout about. We
 * offer a retry only when there's someone to ask, and otherwise let the operator
 * type the number in.
 */
function ContextWindowPanel({
  company,
  emp,
  model,
  onChanged,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(model.contextWindow ?? ""));
  const [busy, setBusy] = React.useState(false);
  const base = `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}`;

  async function probe() {
    setBusy(true);
    try {
      const updated = await api.post<AIModel>(`${base}/refresh`);
      toast(
        updated.contextWindow
          ? `Context window: ${updated.contextWindow.toLocaleString()} tokens`
          : "The endpoint still doesn't report a context window — set it by hand below.",
        updated.contextWindow ? "success" : "error",
      );
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function save(next: number | null) {
    setBusy(true);
    try {
      await api.put(`${base}/context-window`, { contextWindow: next });
      toast(next ? "Context window saved" : "Context window cleared", "success");
      setEditing(false);
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const parsed = Number(draft.trim());
  const draftValid = /^\d+$/.test(draft.trim()) && parsed >= 1024 && parsed <= 20_000_000;

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Context window
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {model.contextWindow ? (
              <>
                <span className="tabular-nums text-slate-700 dark:text-slate-200">
                  {model.contextWindow.toLocaleString()}
                </span>{" "}
                tokens ·{" "}
                {model.contextWindowSource === "manual"
                  ? "set by hand"
                  : "reported by the provider"}
              </>
            ) : (
              <>
                Unknown — runs on this model {"can't"} budget their context, and will
                only notice an over-long prompt once the provider rejects it.
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {model.contextWindowProbeable && (
            <Button size="sm" variant="ghost" onClick={probe} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              Ask the provider
            </Button>
          )}
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(String(model.contextWindow ?? ""));
                setEditing(true);
              }}
              disabled={busy}
            >
              <Edit3 size={14} /> Set manually
            </Button>
          )}
          {model.contextWindowSource === "manual" && !editing && (
            <Button size="sm" variant="ghost" onClick={() => save(null)} disabled={busy}>
              <X size={14} /> Clear
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftValid) save(parsed);
          }}
        >
          <div className="w-44">
            <Input
              label="Tokens"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="65536"
              inputMode="numeric"
              autoFocus
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !draftValid}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <p className="w-full text-xs text-slate-500 dark:text-slate-400">
            Whatever the server was launched with — vLLM{"'"}s <code>--max-model-len</code>,
            llama.cpp{"'"}s <code>-c</code>, or the model{"'"}s documented limit. A number
            set here wins over anything the provider reports.
          </p>
        </form>
      )}
    </div>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300">
        <Check size={10} /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300">
      <Loader2 size={10} className="animate-spin" /> Waiting
    </span>
  );
}

function ActiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300">
      <BrainCircuit size={10} /> Active
    </span>
  );
}

function apiKeyPlaceholder(p: Provider): string {
  return p === "openai" ? "sk-…" : "sk-ant-…";
}

function ApiKeyPanel({
  company,
  emp,
  model,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onSaved: () => void;
}) {
  const [key, setKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/apikey`,
            { apiKey: key },
          );
          setKey("");
          toast("API key saved", "success");
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <Input
        label={model.apiKeyEnv ?? "API key"}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={apiKeyPlaceholder(model.provider)}
        required
      />
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Stored encrypted at rest. Removed on disconnect.
      </div>
      <div>
        <Button type="submit" disabled={saving || key.length === 0}>
          {saving ? "Saving…" : "Save key"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Form for the customEndpoint auth mode. Three fields: base URL, model id,
 * optional API key. Base URL is the load-bearing signal: until it's saved the
 * model row stays in "Waiting" status even though provider + auth are set.
 */
function CustomEndpointPanel({
  company,
  emp,
  model,
  onSaved,
}: {
  company: Company;
  emp: Employee;
  model: AIModel;
  onSaved: () => void;
}) {
  const [baseURL, setBaseURL] = React.useState("");
  const [modelId, setModelId] = React.useState(model.customEndpointModelId ?? "");
  const [apiKey, setApiKey] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const connected = model.status === "connected";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.post(
            `/api/companies/${company.id}/employees/${emp.id}/models/${model.id}/custom-endpoint`,
            {
              baseURL,
              modelId,
              ...(apiKey ? { apiKey } : {}),
            },
          );
          setApiKey("");
          toast(connected ? "Endpoint updated" : "Endpoint connected", "success");
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Base URL"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder={baseUrlPlaceholder(model.provider)}
          required
        />
        <Input
          label="Model id"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="qwen2.5-coder:32b"
          required
        />
      </div>
      <Input
        label={`API key (optional — most local servers ignore this)`}
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={model.customEndpointHasApiKey ? "•••••••• (replace to update)" : "leave blank if not needed"}
      />
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Point this employee at a self-hosted OpenAI-compatible server. Base URL +
        key are stored encrypted at rest.
      </div>
      <div>
        <Button type="submit" disabled={saving || baseURL.length === 0 || modelId.length === 0}>
          {saving ? "Saving…" : connected ? "Update endpoint" : "Save & connect"}
        </Button>
      </div>
    </form>
  );
}

function baseUrlPlaceholder(_provider: Provider): string {
  // Ollama's port is the easiest sanity check; vLLM and llama-server are also
  // documented in /docs. host.docker.internal reaches the host from the container.
  return "http://host.docker.internal:11434/v1";
}

const JOURNAL_KIND_STYLE: Record<JournalKind, string> = {
  run: "bg-sky-50 text-sky-700 border-sky-200",
  note: "bg-slate-50 text-slate-700 border-slate-200",
  system: "bg-violet-50 text-violet-700 border-violet-200",
};

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
  const { toast } = useToast();
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  async function reload() {
    try {
      const list = await api.get<JournalEntryT[]>(`${base}/journal`);
      setEntries(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setEntries([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
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
      toast((err as Error).message, "error");
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
    try {
      await api.del(`${base}/journal/${id}`);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function updateEntry(
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<boolean> {
    try {
      const updated = await api.patch<JournalEntryT>(`${base}/journal/${id}`, patch);
      setEntries((prev) =>
        prev ? prev.map((e) => (e.id === id ? updated : e)) : prev,
      );
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    }
  }

  return (
    <>
      <TopBar title="Journal" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            A daily diary of what this employee did. Routine runs land here automatically.
            <strong className="text-slate-700 dark:text-slate-200">
              {" "}The last 7 days are auto-injected into every chat and routine run
            </strong>
            {" "}— they&apos;re how the employee remembers what happened yesterday.
          </p>
          <form onSubmit={addNote} className="mt-3 flex flex-col gap-2">
            <Input
              label="Add note"
              placeholder="What should this employee remember?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Optional detail…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            />
            <div>
              <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
                <BookText size={14} /> {saving ? "Saving…" : "Add entry"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {entries === null ? (
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
  onSave,
  onDelete,
}: {
  entry: JournalEntryT;
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
                {entry.kind}
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
              {new Date(entry.createdAt).toLocaleString()}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  onClick={save}
                  disabled={saving || !draftTitle.trim()}
                >
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
              <Button
                size="sm"
                variant="ghost"
                onClick={start}
                aria-label="Edit entry"
              >
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
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
  const { toast } = useToast();
  const dialog = useDialog();

  const base = `/api/companies/${company.id}/employees/${emp.id}`;

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<MemoryItem[]>(`${base}/memory`);
      setItems(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setItems([]);
    }
  }, [base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
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
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function update(
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<boolean> {
    try {
      const updated = await api.patch<MemoryItem>(`${base}/memory/${id}`, patch);
      setItems((prev) => (prev ? prev.map((x) => (x.id === id ? updated : x)) : prev));
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    }
  }

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete this memory?",
      message: "The employee will stop recalling this fact on their next spawn.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/memory/${id}`);
      setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar title="Memory" />
      <Card>
        <CardBody>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Durable facts and preferences this employee should recall in
            <strong className="text-slate-700 dark:text-slate-200"> every conversation and routine run</strong>
            . Unlike the free-form Soul, each memory item is a single short fact you can add, edit, or delete without touching the others. {emp.name} can also curate these themselves via MCP tools.
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
              rows={2}
              placeholder="Optional elaboration…"
              className="resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600 dark:text-slate-100"
            />
            <div>
              <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
                <Plus size={14} /> {saving ? "Saving…" : "Add memory"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4">
        {items === null ? (
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
  onSave,
  onDelete,
}: {
  item: MemoryItem;
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
              Added {new Date(item.createdAt).toLocaleString()}
              {item.updatedAt && item.updatedAt !== item.createdAt && (
                <> · updated {new Date(item.updatedAt).toLocaleString()}</>
              )}
            </div>
            {editing && (
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  onClick={save}
                  disabled={saving || !draftTitle.trim()}
                >
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
              <Button
                size="sm"
                variant="ghost"
                onClick={start}
                aria-label="Edit memory"
              >
                <Edit3 size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
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
 * Per-employee MCP (Model Context Protocol) server list. Adding a server
 * writes its config into `.mcp.json` at the employee's workspace root on
 * the next spawn, so tools show up natively to the model.
 */
export function McpPage() {
  const { company, emp } = useCtx();
  const [servers, setServers] = React.useState<McpServer[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const { toast } = useToast();
  const dialog = useDialog();
  const base = `/api/companies/${company.id}/employees/${emp.id}/mcp`;

  async function reload() {
    try {
      const list = await api.get<McpServer[]>(base);
      setServers(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setServers([]);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  async function remove(id: string) {
    const ok = await dialog.confirm({
      title: "Delete MCP server?",
      message: "This server will no longer be materialized into .mcp.json for this employee.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${base}/${id}`);
      setServers((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar
        title="MCP servers"
        right={<Button onClick={() => setAdding(true)}>Add server</Button>}
      />
      <div className="mb-3">
        <ExternalMcpPanel company={company} emp={emp} />
      </div>
      {servers === null ? (
        <Spinner />
      ) : servers.length === 0 ? (
        <EmptyState
          title="No MCP servers yet"
          description="Attach tools via the Model Context Protocol so this employee can use them from any provider CLI."
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(s.id)}
                    aria-label="Delete MCP server"
                  >
                    <Trash2 size={12} />
                  </Button>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
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
 * Read-only panel on the MCP tab showing the employee's external MCP endpoint.
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
          <ExternalLink
            size={14}
            className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">Connect an external harness</div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Point any MCP client — Claude Desktop, Cursor, or your own agent —
              at the URL below to use {emp.name}
              {"’"}s built-in Genosyn tools over Streamable HTTP.
              Authenticate with an{" "}
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
  const { toast } = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
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
      await api.post(
        `/api/companies/${company.id}/employees/${emp.id}/mcp`,
        body,
      );
      onCreated();
    } catch (err) {
      toast((err as Error).message, "error");
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
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Transport</label>
          <div className="flex gap-2">
            {(["stdio", "http"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  checked={transport === t}
                  onChange={() => setTransport(t)}
                />
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
            Tool names matching these patterns (<code>*</code> wildcard) queue a
            human Approval instead of running. Guard anything that mutates —
            budget changes, sends, deletes.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={saving || !name.trim()}>
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
