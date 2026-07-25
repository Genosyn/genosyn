import React from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Settings2, Trash2 } from "lucide-react";
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

export default function RevenueSetup() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const base = `/api/companies/${company.id}/revenue`;
  const sectionUrl = `/c/${company.slug}/revenue`;
  const [classifications, setClassifications] = React.useState<RevenueClassification[] | null>(null);
  const [fields, setFields] = React.useState<RevenueCustomField[] | null>(null);
  const [addClassification, setAddClassification] = React.useState<RevenueClassification["kind"] | null>(null);
  const [addField, setAddField] = React.useState<RevenueResourceType | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [controlled, custom] = await Promise.all([
      api.get<{ rows: RevenueClassification[] }>(`${base}/classifications`),
      api.get<{ rows: RevenueCustomField[] }>(`${base}/custom-fields`),
    ]);
    setClassifications(controlled.rows);
    setFields(custom.rows);
    setError(null);
  }, [base]);

  React.useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [reload]);

  async function archive(path: "classifications" | "custom-fields", id: string) {
    try {
      await api.patch(`${base}/${path}/${id}`, { archived: true });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <Breadcrumbs items={[{ label: "Revenue", to: sectionUrl }, { label: "Setup" }]} />
      <div className="mb-6 mt-5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100"><Settings2 size={22} /> Revenue setup</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Keep reporting clean with controlled classifications, then add typed fields for the company-specific facts that matter.
        </p>
      </div>
      {error && <div className="mb-4"><FormError message={error} /></div>}
      {!classifications || !fields ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Controlled classifications</h2>
            <p className="mt-1 text-sm text-slate-500">Stable values prevent “Inbound”, “inbound”, and “website” from fragmenting reports.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(Object.keys(CLASSIFICATION_LABEL) as RevenueClassification["kind"][]).map((kind) => (
                <div key={kind} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium text-slate-900 dark:text-slate-100">{CLASSIFICATION_LABEL[kind]}</h3>
                    <Button size="sm" variant="ghost" onClick={() => setAddClassification(kind)}><Plus size={14} /> Add</Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {classifications.filter((row) => row.kind === kind).map((row) => (
                      <span key={row.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {row.label}
                        <button type="button" onClick={() => void archive("classifications", row.id)} className="text-slate-400 hover:text-rose-600" aria-label={`Archive ${row.label}`}><Trash2 size={11} /></button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Custom fields</h2>
            <p className="mt-1 text-sm text-slate-500">Typed values stay filterable and reportable for Members and AI Employees.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(Object.keys(RESOURCE_LABEL) as RevenueResourceType[]).map((resourceType) => (
                <div key={resourceType} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium text-slate-900 dark:text-slate-100">{RESOURCE_LABEL[resourceType]}</h3>
                    <Button size="sm" variant="ghost" onClick={() => setAddField(resourceType)}><Plus size={14} /> Add</Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {fields.filter((field) => field.resourceType === resourceType).map((field) => (
                      <div key={field.id} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2 dark:border-slate-800">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{field.name}</p>
                          <p className="text-xs text-slate-500">{FIELD_TYPE_LABEL[field.fieldType]} · {field.key}</p>
                        </div>
                        <button type="button" onClick={() => void archive("custom-fields", field.id)} className="text-slate-400 hover:text-rose-600" aria-label={`Archive ${field.name}`}><Trash2 size={14} /></button>
                      </div>
                    ))}
                    {!fields.some((field) => field.resourceType === resourceType) && <p className="text-sm text-slate-500">No custom fields.</p>}
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
    <Modal open={open} onClose={onClose} title={kind ? `Add to ${CLASSIFICATION_LABEL[kind]}` : "Add classification"}>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit">Add value</Button></div>
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
        options: options.split(",").map((option) => option.trim()).filter(Boolean),
      });
      setName("");
      setOptions("");
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={resourceType ? `New ${RESOURCE_LABEL[resourceType].toLowerCase()} field` : "New custom field"}>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Field name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="Type" value={fieldType} onChange={(e) => setFieldType(e.target.value as RevenueCustomFieldType)}>
          {Object.entries(FIELD_TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        {(fieldType === "select" || fieldType === "multi_select") && <Input label="Options" placeholder="Enterprise, Growth, Starter" value={options} onChange={(e) => setOptions(e.target.value)} />}
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required</label>
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit">Create field</Button></div>
      </form>
    </Modal>
  );
}
