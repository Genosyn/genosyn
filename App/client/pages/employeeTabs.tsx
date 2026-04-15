import React from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import {
  BrainCircuit,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Play,
  PlugZap,
  Sparkles,
  Trash2,
  Unplug,
} from "lucide-react";
import cronstrue from "cronstrue";
import {
  api,
  AIModel,
  AuthMode,
  Company,
  Employee,
  Provider,
  Routine,
  Skill,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { Select } from "../components/ui/Select";
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
 * SoulCard — the SOUL.md editor. Used inline on the employee Settings page
 * (no longer has its own sidebar entry; Soul sits with the rest of the
 * per-employee settings).
 */
function SoulCard({ company, emp }: { company: Company; emp: Employee }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/employees/${emp.id}/soul`)
      .then((r) => setContent(r.content));
  }, [company.id, emp.id]);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Soul</div>
          <div className="text-xs text-slate-500">
            {emp.name}&apos;s constitution — edited here, stored as{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px]">SOUL.md</code> in
            the workspace.
          </div>
        </div>
        {content === null ? (
          <Spinner />
        ) : (
          <>
            <MarkdownEditor value={content} onChange={setContent} rows={16} />
            <div>
              <Button
                onClick={async () => {
                  setSaving(true);
                  try {
                    await api.put(`/api/companies/${company.id}/employees/${emp.id}/soul`, {
                      content,
                    });
                    toast("Soul saved", "success");
                  } catch (err) {
                    toast((err as Error).message, "error");
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save SOUL.md"}
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function SkillsPage() {
  const { company, emp } = useCtx();
  const [skills, setSkills] = React.useState<Skill[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [editing, setEditing] = React.useState<Skill | null>(null);
  const { toast } = useToast();

  async function reload() {
    const s = await api.get<Skill[]>(
      `/api/companies/${company.id}/employees/${emp.id}/skills`,
    );
    setSkills(s);
  }
  React.useEffect(() => {
    reload().catch(() => setSkills([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  return (
    <>
      <TopBar
        title="Skills"
        right={<Button onClick={() => setAdding(true)}>New skill</Button>}
      />
      {skills === null ? (
        <Spinner />
      ) : skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="Skills are markdown playbooks an employee can apply to their work."
        />
      ) : (
        <div className="grid gap-3">
          {skills.map((s) => (
            <Card key={s.id} className="cursor-pointer" onClick={() => setEditing(s)}>
              <CardBody className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-400">@{s.slug}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete skill "${s.name}"?`)) return;
                    await api.del(`/api/companies/${company.id}/skills/${s.id}`);
                    reload();
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="New skill">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post(
                `/api/companies/${company.id}/employees/${emp.id}/skills`,
                { name },
              );
              setName("");
              setAdding(false);
              await reload();
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        >
          <Input
            label="Skill name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Button type="submit">Create</Button>
        </form>
      </Modal>
      {editing && (
        <SkillEditor company={company} skill={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function SkillEditor({
  company,
  skill,
  onClose,
}: {
  company: Company;
  skill: Skill;
  onClose: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/skills/${skill.id}/readme`)
      .then((r) => setContent(r.content));
  }, [company.id, skill.id]);

  return (
    <Modal open onClose={onClose} title={`Skill: ${skill.name}`}>
      {content === null ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          <MarkdownEditor value={content} onChange={setContent} rows={14} />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                setSaving(true);
                try {
                  await api.put(`/api/companies/${company.id}/skills/${skill.id}/readme`, {
                    content,
                  });
                  toast("Skill saved", "success");
                  onClose();
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function RoutinesPage() {
  const { company, emp } = useCtx();
  const [routines, setRoutines] = React.useState<Routine[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Routine | null>(null);
  const { toast } = useToast();

  async function reload() {
    const r = await api.get<Routine[]>(
      `/api/companies/${company.id}/employees/${emp.id}/routines`,
    );
    setRoutines(r);
  }

  React.useEffect(() => {
    reload().catch(() => setRoutines([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  return (
    <>
      <TopBar
        title="Routines"
        right={<Button onClick={() => setAdding(true)}>New routine</Button>}
      />
      {routines === null ? (
        <Spinner />
      ) : routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          description="Routines are cron-scheduled work this employee performs automatically."
        />
      ) : (
        <div className="grid gap-3">
          {routines.map((r) => (
            <Card key={r.id}>
              <CardBody className="flex items-center justify-between gap-4">
                <div
                  className="min-w-0 flex-1 cursor-pointer"
                  onClick={() => setEditing(r)}
                >
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{r.name}</div>
                    {!r.enabled && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{cronHuman(r.cronExpr)}</div>
                  <div className="text-xs text-slate-400">
                    {r.lastRunAt ? `Last run ${new Date(r.lastRunAt).toLocaleString()}` : "Never run"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await api.post(`/api/companies/${company.id}/routines/${r.id}/run`);
                        toast("Run started", "success");
                        reload();
                      } catch (err) {
                        toast((err as Error).message, "error");
                      }
                    }}
                  >
                    <Play size={14} /> Run
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm(`Delete routine "${r.name}"?`)) return;
                      await api.del(`/api/companies/${company.id}/routines/${r.id}`);
                      reload();
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <NewRoutineModal
          company={company}
          emp={emp}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {editing && (
        <RoutineEditor
          company={company}
          routine={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function cronHuman(expr: string): string {
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}

const PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Every weekday 9am", expr: "0 9 * * 1-5" },
  { label: "Every Monday 9am", expr: "0 9 * * 1" },
  { label: "Every day 8am", expr: "0 8 * * *" },
];

function NewRoutineModal({
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
  const [cronExpr, setCronExpr] = React.useState("0 9 * * 1-5");
  const { toast } = useToast();

  return (
    <Modal open onClose={onClose} title="New routine">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post(`/api/companies/${company.id}/employees/${emp.id}/routines`, {
              name,
              cronExpr,
            });
            onCreated();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input
          label="Cron expression"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          required
        />
        <div className="-mt-2 text-xs text-slate-500">{cronHuman(cronExpr)}</div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              type="button"
              onClick={() => setCronExpr(p.expr)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              {p.label}
            </button>
          ))}
        </div>
        <Button type="submit">Create</Button>
      </form>
    </Modal>
  );
}

function RoutineEditor({
  company,
  routine,
  onClose,
  onSaved,
}: {
  company: Company;
  routine: Routine;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [name, setName] = React.useState(routine.name);
  const [cronExpr, setCronExpr] = React.useState(routine.cronExpr);
  const [enabled, setEnabled] = React.useState(routine.enabled);
  const [timeoutSec, setTimeoutSec] = React.useState(routine.timeoutSec ?? 600);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/routines/${routine.id}/readme`)
      .then((r) => setContent(r.content));
  }, [company.id, routine.id]);

  return (
    <Modal open onClose={onClose} title={`Routine: ${routine.name}`}>
      {content === null ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Cron expression"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
          />
          <div className="-mt-2 text-xs text-slate-500">{cronHuman(cronExpr)}</div>
          <Input
            label="Timeout (seconds)"
            type="number"
            min={10}
            max={21600}
            value={String(timeoutSec)}
            onChange={(e) => setTimeoutSec(Math.max(10, Number(e.target.value) || 600))}
          />
          <div className="-mt-2 text-xs text-slate-500">
            Hard kill after this long. The Run is marked <code>timeout</code>.
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <MarkdownEditor value={content} onChange={setContent} rows={12} />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  await api.patch(`/api/companies/${company.id}/routines/${routine.id}`, {
                    name,
                    cronExpr,
                    enabled,
                    timeoutSec,
                  });
                  await api.put(
                    `/api/companies/${company.id}/routines/${routine.id}/readme`,
                    { content },
                  );
                  toast("Routine saved", "success");
                  onSaved();
                } catch (err) {
                  toast((err as Error).message, "error");
                }
              }}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- Model (Settings) tab ----------

const PROVIDER_DEFAULTS: Record<
  Provider,
  { label: string; model: string; supportsApiKey: boolean }
> = {
  "claude-code": { label: "claude-code", model: "claude-opus-4-6", supportsApiKey: true },
  codex: { label: "codex", model: "gpt-5-codex", supportsApiKey: true },
  opencode: { label: "opencode", model: "anthropic/claude-opus-4-6", supportsApiKey: false },
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
        <SettingsNavItem to="soul" icon={<Sparkles size={14} />} label="Soul" />
        <SettingsNavItem to="model" icon={<BrainCircuit size={14} />} label="Model" />
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
            ? "bg-indigo-50 text-indigo-700"
            : "text-slate-700 hover:bg-slate-50")
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

export function ModelSettingsPage() {
  const { company, emp } = useCtx();
  return <ModelSection company={company} emp={emp} />;
}

function ModelSection({ company, emp }: { company: Company; emp: Employee }) {
  const [model, setModel] = React.useState<AIModel | null | undefined>(undefined);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    const m = await api.get<AIModel | null>(
      `/api/companies/${company.id}/employees/${emp.id}/model`,
    );
    setModel(m);
  }, [company.id, emp.id]);

  React.useEffect(() => {
    reload().catch(() => setModel(null));
  }, [reload]);

  React.useEffect(() => {
    if (!model || model.status === "connected" || model.authMode !== "subscription") return;
    let alive = true;
    const id = window.setInterval(async () => {
      if (!alive) return;
      try {
        const m = await api.post<AIModel>(
          `/api/companies/${company.id}/employees/${emp.id}/model/refresh`,
        );
        if (!alive) return;
        setModel(m);
        if (m.status === "connected") toast(`${emp.name} signed in`, "success");
      } catch {
        // swallow
      }
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [model, company.id, emp.id, emp.name, toast]);

  if (model === undefined) return <Spinner />;
  if (!model) return <ModelSetup company={company} emp={emp} onSaved={reload} />;
  return (
    <div className="flex flex-col gap-4">
      <ModelStatusCard company={company} emp={emp} model={model} onChanged={reload} />
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="text-sm font-medium text-slate-900">Reconfigure</div>
          <ModelForm
            initial={{ provider: model.provider, model: model.model, authMode: model.authMode }}
            company={company}
            emp={emp}
            onSaved={reload}
            submitLabel="Save changes"
          />
        </CardBody>
      </Card>
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
          <div className="text-sm font-medium text-slate-900">
            Connect a brain for {emp.name}
          </div>
          <div className="text-xs text-slate-500">
            Each AI Employee signs into their own provider — pick one and connect it.
          </div>
        </div>
        <ModelForm
          initial={{ provider: "claude-code", model: "claude-opus-4-6", authMode: "subscription" }}
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
  initial,
  company,
  emp,
  onSaved,
  submitLabel,
}: {
  initial: { provider: Provider; model: string; authMode: AuthMode };
  company: Company;
  emp: Employee;
  onSaved: () => void;
  submitLabel: string;
}) {
  const [provider, setProvider] = React.useState<Provider>(initial.provider);
  const [modelStr, setModelStr] = React.useState(initial.model);
  const [authMode, setAuthMode] = React.useState<AuthMode>(initial.authMode);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const supportsApiKey = PROVIDER_DEFAULTS[provider].supportsApiKey;

  React.useEffect(() => {
    if (!supportsApiKey && authMode === "apikey") setAuthMode("subscription");
  }, [supportsApiKey, authMode]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api.put(`/api/companies/${company.id}/employees/${emp.id}/model`, {
            provider,
            model: modelStr,
            authMode,
          });
          onSaved();
        } catch (err) {
          toast((err as Error).message, "error");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Provider"
          value={provider}
          onChange={(e) => {
            const p = e.target.value as Provider;
            setProvider(p);
            setModelStr(PROVIDER_DEFAULTS[p].model);
          }}
        >
          <option value="claude-code">claude-code</option>
          <option value="codex">codex</option>
          <option value="opencode">opencode</option>
        </Select>
        <Input
          label="Model"
          value={modelStr}
          onChange={(e) => setModelStr(e.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Authentication
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <AuthModeChoice
            active={authMode === "subscription"}
            onClick={() => setAuthMode("subscription")}
            icon={<PlugZap size={16} />}
            title="Sign in with subscription"
            description={subscriptionBlurb(provider)}
          />
          <AuthModeChoice
            active={authMode === "apikey"}
            onClick={() => supportsApiKey && setAuthMode("apikey")}
            disabled={!supportsApiKey}
            icon={<KeyRound size={16} />}
            title="Use an API key"
            description={
              supportsApiKey ? apiKeyBlurb(provider) : "Not supported for this provider."
            }
          />
        </div>
      </div>
      <div>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function subscriptionBlurb(p: Provider): string {
  switch (p) {
    case "claude-code":
      return "Use a Claude Pro or Max plan via `claude login`.";
    case "codex":
      return "Use a ChatGPT plan via `codex login`.";
    case "opencode":
      return "Sign in via `opencode auth login` — any provider opencode supports.";
  }
}

function apiKeyBlurb(p: Provider): string {
  switch (p) {
    case "claude-code":
      return "Pay-as-you-go from console.anthropic.com.";
    case "codex":
      return "Pay-as-you-go from platform.openai.com.";
    case "opencode":
      return "";
  }
}

function AuthModeChoice({
  active,
  onClick,
  icon,
  title,
  description,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition " +
        (disabled
          ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
          : active
            ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-200"
            : "border-slate-200 bg-white hover:bg-slate-50")
      }
    >
      <div
        className={
          "mt-0.5 rounded-md p-1.5 " +
          (active ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500")
        }
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{title}</div>
        <div className="text-xs text-slate-500">{description}</div>
      </div>
    </button>
  );
}

function ModelStatusCard({
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
  const connected = model.status === "connected";

  async function disconnect() {
    if (!confirm(`Disconnect ${emp.name}'s ${model.provider} model?`)) return;
    try {
      await api.del(`/api/companies/${company.id}/employees/${emp.id}/model`);
      toast("Model disconnected", "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">
                {model.provider} · {model.model}
              </span>
              <StatusBadge connected={connected} />
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {model.authMode === "subscription"
                ? `Signed in with ${model.provider} subscription`
                : `Authenticated with ${model.apiKeyEnv ?? "API"} key`}
              {model.connectedAt && connected && (
                <> · connected {new Date(model.connectedAt).toLocaleString()}</>
              )}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={disconnect}>
            <Unplug size={14} /> Disconnect
          </Button>
        </div>

        {!connected && model.authMode === "subscription" && (
          <SubscriptionLoginPanel model={model} />
        )}
        {!connected && model.authMode === "apikey" && (
          <ApiKeyPanel company={company} emp={emp} model={model} onSaved={onChanged} />
        )}
      </CardBody>
    </Card>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
        <Check size={10} /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">
      <Loader2 size={10} className="animate-spin" /> Waiting
    </span>
  );
}

function SubscriptionLoginPanel({ model }: { model: AIModel }) {
  const command = `${model.configDirEnv}=${shellQuote(model.configDir)} ${model.loginCommand}`;
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-600">
        Run this once in any terminal on this server. The page will detect the
        login automatically — no need to refresh.
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">
          {command}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 size={12} className="animate-spin" /> Watching for credentials at{" "}
        <code className="rounded bg-white px-1 py-0.5 text-[11px]">{model.configDir}</code>
      </div>
    </div>
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
            `/api/companies/${company.id}/employees/${emp.id}/model/apikey`,
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
        label={model.apiKeyEnv ?? "API_KEY"}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={model.provider === "codex" ? "sk-…" : "sk-ant-…"}
        required
      />
      <div className="text-xs text-slate-500">
        Stored encrypted at rest. Wiped on disconnect.
      </div>
      <div>
        <Button type="submit" disabled={saving || key.length === 0}>
          {saving ? "Saving…" : "Save key"}
        </Button>
      </div>
    </form>
  );
}
