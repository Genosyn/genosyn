import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Play, Trash2 } from "lucide-react";
import cronstrue from "cronstrue";
import {
  api,
  AIModel,
  Company,
  Employee,
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

type Tab = "soul" | "skills" | "routines";

export default function EmployeeDetail({ company }: { company: Company }) {
  const { empSlug } = useParams();
  const navigate = useNavigate();
  const [emp, setEmp] = React.useState<Employee | null>(null);
  const [tab, setTab] = React.useState<Tab>("soul");
  const { toast } = useToast();

  React.useEffect(() => {
    (async () => {
      const list = await api.get<Employee[]>(`/api/companies/${company.id}/employees`);
      const e = list.find((x) => x.slug === empSlug);
      if (!e) {
        navigate(`/c/${company.slug}`);
        return;
      }
      setEmp(e);
    })().catch(() => {});
  }, [company.id, company.slug, empSlug, navigate]);

  if (!emp) return <div className="p-10 flex justify-center"><Spinner /></div>;

  return (
    <>
      <TopBar
        title={emp.name}
        right={
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              if (!confirm(`Delete ${emp.name}?`)) return;
              try {
                await api.del(`/api/companies/${company.id}/employees/${emp.id}`);
                navigate(`/c/${company.slug}`);
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }}
          >
            <Trash2 size={14} /> Delete
          </Button>
        }
      />
      <div className="mb-4 text-sm text-slate-500">{emp.role}</div>
      <div className="mb-6 flex gap-1 border-b border-slate-200">
        {(["soul", "skills", "routines"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "relative -mb-px px-4 py-2 text-sm font-medium capitalize " +
              (tab === t
                ? "border-b-2 border-indigo-600 text-slate-900"
                : "text-slate-500 hover:text-slate-900")
            }
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "soul" && <SoulTab company={company} emp={emp} />}
      {tab === "skills" && <SkillsTab company={company} emp={emp} />}
      {tab === "routines" && <RoutinesTab company={company} emp={emp} />}
    </>
  );
}

function SoulTab({ company, emp }: { company: Company; emp: Employee }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    api
      .get<{ content: string }>(`/api/companies/${company.id}/employees/${emp.id}/soul`)
      .then((r) => setContent(r.content));
  }, [company.id, emp.id]);

  if (content === null) return <Spinner />;
  return (
    <div className="flex flex-col gap-3">
      <MarkdownEditor value={content} onChange={setContent} rows={20} />
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
    </div>
  );
}

function SkillsTab({ company, emp }: { company: Company; emp: Employee }) {
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

  if (skills === null) return <Spinner />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setAdding(true)}>New skill</Button>
      </div>
      {skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="Skills are markdown playbooks an employee can apply to their work."
        />
      ) : (
        <div className="grid gap-3">
          {skills.map((s) => (
            <Card
              key={s.id}
              className="cursor-pointer"
              onClick={() => setEditing(s)}
            >
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
        <SkillEditor
          company={company}
          skill={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
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

function RoutinesTab({ company, emp }: { company: Company; emp: Employee }) {
  const [routines, setRoutines] = React.useState<Routine[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Routine | null>(null);
  const [models, setModels] = React.useState<AIModel[]>([]);
  const { toast } = useToast();

  async function reload() {
    const r = await api.get<Routine[]>(
      `/api/companies/${company.id}/employees/${emp.id}/routines`,
    );
    setRoutines(r);
  }

  React.useEffect(() => {
    reload().catch(() => setRoutines([]));
    api.get<AIModel[]>(`/api/companies/${company.id}/models`).then(setModels).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp.id]);

  if (routines === null) return <Spinner />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setAdding(true)}>New routine</Button>
      </div>
      {routines.length === 0 ? (
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
          models={models}
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
          models={models}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
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
  models,
  onClose,
  onCreated,
}: {
  company: Company;
  emp: Employee;
  models: AIModel[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [cronExpr, setCronExpr] = React.useState("0 9 * * 1-5");
  const [modelId, setModelId] = React.useState("");
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
              modelId: modelId || undefined,
            });
            onCreated();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      >
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
        <Select
          label="AI Model override (optional)"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        >
          <option value="">— Use employee default —</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.provider}/{m.model}
            </option>
          ))}
        </Select>
        <Button type="submit">Create</Button>
      </form>
    </Modal>
  );
}

function RoutineEditor({
  company,
  routine,
  models,
  onClose,
  onSaved,
}: {
  company: Company;
  routine: Routine;
  models: AIModel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [name, setName] = React.useState(routine.name);
  const [cronExpr, setCronExpr] = React.useState(routine.cronExpr);
  const [enabled, setEnabled] = React.useState(routine.enabled);
  const [modelId, setModelId] = React.useState(routine.modelId ?? "");
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <Select
            label="AI Model override"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            <option value="">— Use employee default —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.provider}/{m.model}
              </option>
            ))}
          </Select>
          <MarkdownEditor value={content} onChange={setContent} rows={12} />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  await api.patch(`/api/companies/${company.id}/routines/${routine.id}`, {
                    name,
                    cronExpr,
                    enabled,
                    modelId: modelId || null,
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
