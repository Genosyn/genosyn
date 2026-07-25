import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  RevenueClassification,
  RevenueCustomField,
  RevenueCustomFieldType,
  RevenueResourceType,
} from "../lib/revenue";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { RevenueOutletCtx } from "./RevenueLayout";

const CLASSIFICATION_LABEL: Record<RevenueClassification["kind"], string> = {
  deal_source: "Deal sources",
  committee_role: "Buying committee roles",
  partnership_type: "Partnership types",
  partnership_status: "Partnership statuses",
};

const RESOURCE_LABEL: Record<RevenueResourceType, string> = {
  contact: "Contacts",
  account: "Accounts",
  deal: "Deals",
  partnership: "Partnerships",
};

const FIELD_TYPE_LABEL: Record<RevenueCustomFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes / no",
  select: "Single select",
  multi_select: "Multi-select",
  url: "URL",
};

type DealStage = {
  id: string;
  name: string;
  probability: number;
  kind: "open" | "won" | "lost";
  color: string;
  description: string;
};

export default function RevenueSetup() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [stages, setStages] = React.useState<DealStage[] | null>(null);
  const [classifications, setClassifications] = React.useState<RevenueClassification[] | null>(
    null,
  );
  const [fields, setFields] = React.useState<RevenueCustomField[] | null>(null);
  const [editingStage, setEditingStage] = React.useState<DealStage | "new" | null>(null);
  const [addClassification, setAddClassification] = React.useState<
    RevenueClassification["kind"] | null
  >(null);
  const [editingClassification, setEditingClassification] =
    React.useState<RevenueClassification | null>(null);
  const [addField, setAddField] = React.useState<RevenueResourceType | null>(null);
  const [editingField, setEditingField] = React.useState<RevenueCustomField | null>(null);
  const [installingPreset, setInstallingPreset] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [stageRows, controlled, custom] = await Promise.all([
      api.get<DealStage[]>(`${base}/stages`),
      api.get<{ rows: RevenueClassification[] }>(`${base}/classifications?includeArchived=true`),
      api.get<{ rows: RevenueCustomField[] }>(`${base}/custom-fields?includeArchived=true`),
    ]);
    setStages(stageRows);
    setClassifications(controlled.rows);
    setFields(custom.rows);
    setError(null);
  }, [base]);

  React.useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [reload]);

  async function setArchived(
    path: "classifications" | "custom-fields",
    id: string,
    archived: boolean,
  ) {
    try {
      await api.patch(`${base}/${path}/${id}`, { archived });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function moveStage(index: number, direction: -1 | 1) {
    if (!stages) return;
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    const next = [...stages];
    [next[index], next[target]] = [next[target], next[index]];
    setStages(next);
    try {
      const saved = await api.post<DealStage[]>(`${base}/stages/reorder`, {
        orderedIds: next.map((stage) => stage.id),
      });
      setStages(saved);
    } catch (cause) {
      setStages(stages);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function archiveStage(stage: DealStage) {
    try {
      await api.del(`${base}/stages/${stage.id}`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function installPreset() {
    setInstallingPreset(true);
    setError(null);
    try {
      await api.post(`${base}/custom-fields/base-migration-preset`, {});
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstallingPreset(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Setup" }]} />
      <div className="mb-6 mt-5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
          <Settings2 size={22} /> Revenue setup
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Keep reporting clean with controlled classifications, then add typed fields for the
          company-specific facts that matter.
        </p>
      </div>
      {error && (
        <div className="mb-4">
          <FormError message={error} />
        </div>
      )}
      {!stages || !classifications || !fields ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-8">
          <section>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Deal Stages
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  The flat, ordered sales process. Stage kind drives Deal status and is fixed after
                  creation.
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setEditingStage("new")}>
                <Plus size={14} /> Add stage
              </Button>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              {stages.map((stage, index) => (
                <div
                  key={stage.id}
                  className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 dark:border-slate-800"
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: stage.color || "#94a3b8" }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                      {stage.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {stage.kind} · {stage.probability}% probability
                      {stage.description ? ` · ${stage.description}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void moveStage(index, -1)}
                    disabled={index === 0}
                    className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                    aria-label={`Move ${stage.name} up`}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveStage(index, 1)}
                    disabled={index === stages.length - 1}
                    className="rounded p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                    aria-label={`Move ${stage.name} down`}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingStage(stage)}
                    className="rounded p-1 text-slate-400 hover:text-indigo-600"
                    aria-label={`Edit ${stage.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void archiveStage(stage)}
                    className="rounded p-1 text-slate-400 hover:text-rose-600"
                    aria-label={`Archive ${stage.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Controlled classifications
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Stable values prevent “Inbound”, “inbound”, and “website” from fragmenting reports.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(Object.keys(CLASSIFICATION_LABEL) as RevenueClassification["kind"][]).map(
                (kind) => (
                  <div
                    key={kind}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-medium text-slate-900 dark:text-slate-100">
                        {CLASSIFICATION_LABEL[kind]}
                      </h3>
                      <Button size="sm" variant="ghost" onClick={() => setAddClassification(kind)}>
                        <Plus size={14} /> Add
                      </Button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {classifications
                        .filter((row) => row.kind === kind)
                        .map((row) => (
                          <span
                            key={row.id}
                            className={`inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200 ${row.archivedAt ? "opacity-50" : ""}`}
                          >
                            {row.label}
                            {row.archivedAt && <span>· archived</span>}
                            <button
                              type="button"
                              onClick={() => setEditingClassification(row)}
                              className="text-slate-400 hover:text-indigo-600"
                              aria-label={`Edit ${row.label}`}
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void setArchived("classifications", row.id, !row.archivedAt)
                              }
                              className="text-slate-400 hover:text-rose-600"
                              aria-label={`${row.archivedAt ? "Restore" : "Archive"} ${row.label}`}
                            >
                              {row.archivedAt ? <RotateCcw size={11} /> : <Trash2 size={11} />}
                            </button>
                          </span>
                        ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          </section>

          <section>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  Custom fields
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Typed values stay filterable and reportable for Members and AI Employees.
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void installPreset()}
                disabled={installingPreset}
              >
                <Sparkles size={14} /> {installingPreset ? "Installing…" : "Add migration fields"}
              </Button>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(Object.keys(RESOURCE_LABEL) as RevenueResourceType[]).map((resourceType) => (
                <div
                  key={resourceType}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium text-slate-900 dark:text-slate-100">
                      {RESOURCE_LABEL[resourceType]}
                    </h3>
                    <Button size="sm" variant="ghost" onClick={() => setAddField(resourceType)}>
                      <Plus size={14} /> Add
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {fields
                      .filter((field) => field.resourceType === resourceType)
                      .map((field) => (
                        <div
                          key={field.id}
                          className={`flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800 ${field.archivedAt ? "opacity-50" : ""}`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                              {field.name}
                            </p>
                            <p className="text-xs text-slate-500">
                              {FIELD_TYPE_LABEL[field.fieldType]} · {field.key}
                              {field.archivedAt ? " · archived" : ""}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setEditingField(field)}
                            className="text-slate-400 hover:text-indigo-600"
                            aria-label={`Edit ${field.name}`}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void setArchived("custom-fields", field.id, !field.archivedAt)
                            }
                            className="text-slate-400 hover:text-rose-600"
                            aria-label={`${field.archivedAt ? "Restore" : "Archive"} ${field.name}`}
                          >
                            {field.archivedAt ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      ))}
                    {!fields.some((field) => field.resourceType === resourceType) && (
                      <p className="text-sm text-slate-500">No custom fields.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <AddClassificationModal
        open={addClassification !== null}
        kind={addClassification}
        base={base}
        onClose={() => setAddClassification(null)}
        onAdded={() => {
          setAddClassification(null);
          void reload();
        }}
      />
      <EditClassificationModal
        row={editingClassification}
        base={base}
        onClose={() => setEditingClassification(null)}
        onSaved={() => {
          setEditingClassification(null);
          void reload();
        }}
      />
      <AddCustomFieldModal
        open={addField !== null}
        resourceType={addField}
        base={base}
        onClose={() => setAddField(null)}
        onAdded={() => {
          setAddField(null);
          void reload();
        }}
      />
      <EditCustomFieldModal
        field={editingField}
        base={base}
        onClose={() => setEditingField(null)}
        onSaved={() => {
          setEditingField(null);
          void reload();
        }}
      />
      <StageModal
        stage={editingStage}
        base={base}
        onClose={() => setEditingStage(null)}
        onSaved={() => {
          setEditingStage(null);
          void reload();
        }}
      />
    </div>
  );
}

function AddClassificationModal({
  open,
  kind,
  base,
  onClose,
  onAdded,
}: {
  open: boolean;
  kind: RevenueClassification["kind"] | null;
  base: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!kind) return;
    try {
      await api.post(`${base}/classifications`, { kind, label });
      setLabel("");
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind ? `Add to ${CLASSIFICATION_LABEL[kind]}` : "Add classification"}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Add value</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddCustomFieldModal({
  open,
  resourceType,
  base,
  onClose,
  onAdded,
}: {
  open: boolean;
  resourceType: RevenueResourceType | null;
  base: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = React.useState("");
  const [fieldType, setFieldType] = React.useState<RevenueCustomFieldType>("text");
  const [options, setOptions] = React.useState("");
  const [required, setRequired] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!resourceType) return;
    try {
      await api.post(`${base}/custom-fields`, {
        resourceType,
        name,
        fieldType,
        required,
        options: options
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean),
      });
      setName("");
      setOptions("");
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        resourceType
          ? `New ${RESOURCE_LABEL[resourceType].toLowerCase()} field`
          : "New custom field"
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Input label="Field name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select
          label="Type"
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value as RevenueCustomFieldType)}
        >
          {Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        {(fieldType === "select" || fieldType === "multi_select") && (
          <Input
            label="Options"
            placeholder="Enterprise, Growth, Starter"
            value={options}
            onChange={(e) => setOptions(e.target.value)}
          />
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />{" "}
          Required
        </label>
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Create field</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditClassificationModal({
  row,
  base,
  onClose,
  onSaved,
}: {
  row: RevenueClassification | null;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setLabel(row?.label ?? "");
    setError(null);
  }, [row]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!row) return;
    try {
      await api.patch(`${base}/classifications/${row.id}`, { label });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal open={row !== null} onClose={onClose} title="Edit classification">
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required
        />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditCustomFieldModal({
  field,
  base,
  onClose,
  onSaved,
}: {
  field: RevenueCustomField | null;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [options, setOptions] = React.useState("");
  const [required, setRequired] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setName(field?.name ?? "");
    setRequired(field?.required ?? false);
    try {
      const parsed = field ? (JSON.parse(field.optionsJson) as unknown) : [];
      setOptions(Array.isArray(parsed) ? parsed.join(", ") : "");
    } catch {
      setOptions("");
    }
    setError(null);
  }, [field]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!field) return;
    try {
      await api.patch(`${base}/custom-fields/${field.id}`, {
        name,
        required,
        options: options
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal open={field !== null} onClose={onClose} title="Edit custom field">
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Field name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Input label="Stable key" value={field?.key ?? ""} disabled />
        {(field?.fieldType === "select" || field?.fieldType === "multi_select") && (
          <Input
            label="Options"
            value={options}
            onChange={(event) => setOptions(event.target.value)}
          />
        )}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
          Required
        </label>
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}

function StageModal({
  stage,
  base,
  onClose,
  onSaved,
}: {
  stage: DealStage | "new" | null;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [probability, setProbability] = React.useState("0");
  const [kind, setKind] = React.useState<DealStage["kind"]>("open");
  const [color, setColor] = React.useState("#94a3b8");
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const current = stage && stage !== "new" ? stage : null;
    setName(current?.name ?? "");
    setProbability(String(current?.probability ?? 0));
    setKind(current?.kind ?? "open");
    setColor(current?.color || "#94a3b8");
    setDescription(current?.description ?? "");
    setError(null);
  }, [stage]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stage) return;
    try {
      const body = {
        name,
        probability: Number(probability),
        color,
        description,
        ...(stage === "new" ? { kind } : {}),
      };
      if (stage === "new") await api.post(`${base}/stages`, body);
      else await api.patch(`${base}/stages/${stage.id}`, body);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal
      open={stage !== null}
      onClose={onClose}
      title={stage === "new" ? "New Deal Stage" : "Edit Deal Stage"}
    >
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Probability"
            type="number"
            min="0"
            max="100"
            value={probability}
            onChange={(event) => setProbability(event.target.value)}
          />
          <Input
            label="Colour"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
        <Select
          label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as DealStage["kind"])}
          disabled={stage !== "new"}
        >
          <option value="open">Open</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </Select>
        <Input
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save stage</Button>
        </div>
      </form>
    </Modal>
  );
}
