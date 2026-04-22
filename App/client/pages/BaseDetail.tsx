import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Plus,
  Trash2,
  Settings as SettingsIcon,
  Sparkles,
  Type,
  AlignLeft,
  Hash,
  CheckSquare,
  Calendar,
  Mail,
  LinkIcon,
  ListFilter,
  ListChecks,
  Key,
  ChevronDown,
  X,
  Users,
} from "lucide-react";
import {
  api,
  Base,
  BaseField,
  BaseFieldType,
  BaseGrant,
  BaseLinkOption,
  BaseRecord,
  BaseTable,
  BaseTableContent,
  Company,
  Employee,
  SelectOption,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { useBases } from "./BasesLayout";
import { CellEditor, CellView, SelectOptionsEditor } from "./BaseGridCells";
import { BaseAssistant } from "./BaseAssistant";
import {
  BASE_COLORS,
  BASE_ICON_NAMES,
  BaseIcon,
  baseAccent,
} from "../components/BaseIcons";
import { clsx } from "../components/ui/clsx";

const FIELD_TYPE_META: Record<
  BaseFieldType,
  { label: string; icon: React.ElementType; desc: string }
> = {
  text: { label: "Text", icon: Type, desc: "One-line text" },
  longtext: { label: "Long text", icon: AlignLeft, desc: "Multi-line text" },
  number: { label: "Number", icon: Hash, desc: "Numeric value" },
  checkbox: { label: "Checkbox", icon: CheckSquare, desc: "True / false" },
  date: { label: "Date", icon: Calendar, desc: "Calendar date" },
  datetime: { label: "Date & time", icon: Calendar, desc: "Date with time" },
  email: { label: "Email", icon: Mail, desc: "Email address" },
  url: { label: "URL", icon: LinkIcon, desc: "Web link" },
  select: { label: "Single select", icon: ListFilter, desc: "One colored tag" },
  multiselect: { label: "Multi-select", icon: ListChecks, desc: "Multiple colored tags" },
  link: { label: "Link to table", icon: LinkIcon, desc: "Reference rows in another table" },
};

export default function BaseDetail({ company }: { company: Company }) {
  const { baseSlug, tableSlug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activeDetail, reloadActive, reload: reloadBases } = useBases();

  const [content, setContent] = React.useState<BaseTableContent | null>(null);
  const [contentLoading, setContentLoading] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showAssistant, setShowAssistant] = React.useState(false);

  // `activeDetail` may belong to the previous base (during nav). Only trust it
  // once the slug matches the URL.
  const detail =
    activeDetail && activeDetail.base.slug === baseSlug ? activeDetail : null;

  const currentTable = React.useMemo(() => {
    if (!detail) return null;
    if (tableSlug) return detail.tables.find((t) => t.slug === tableSlug) ?? null;
    return detail.tables[0] ?? null;
  }, [detail, tableSlug]);

  // Route to the first table when landing on the bare base URL.
  React.useEffect(() => {
    if (!detail || tableSlug) return;
    const first = detail.tables[0];
    if (first) {
      navigate(
        `/c/${company.slug}/bases/${detail.base.slug}/${first.slug}`,
        { replace: true },
      );
    }
  }, [company.slug, detail, navigate, tableSlug]);

  const loadContent = React.useCallback(
    async (silent = false) => {
      if (!detail || !currentTable) {
        setContent(null);
        return;
      }
      if (!silent) setContentLoading(true);
      try {
        const d = await api.get<BaseTableContent>(
          `/api/companies/${company.id}/bases/${detail.base.slug}/tables/${currentTable.id}/rows`,
        );
        setContent(d);
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        if (!silent) setContentLoading(false);
      }
    },
    [company.id, currentTable, detail, toast],
  );

  React.useEffect(() => {
    loadContent();
  }, [loadContent]);

  if (!detail) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { base, tables } = detail;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Base header */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-3 dark:bg-slate-900 dark:border-slate-700">
          <div
            className={
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
              baseAccent(base.color, "tile")
            }
          >
            <BaseIcon name={base.icon} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <Breadcrumbs
              items={[
                { label: "Bases", to: `/c/${company.slug}/bases` },
                { label: base.name, to: `/c/${company.slug}/bases/${base.slug}` },
                ...(currentTable ? [{ label: currentTable.name }] : []),
              ]}
            />
            <h1 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {currentTable ? currentTable.name : base.name}
            </h1>
          </div>
          <button
            onClick={() => setShowAssistant((s) => !s)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition",
              showAssistant
                ? "border-violet-300 bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:border-violet-800 dark:text-violet-300"
                : "border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
            )}
            title="Base assistant"
          >
            <Sparkles size={13} /> AI assistant
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Base settings"
          >
            <SettingsIcon size={16} />
          </button>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-auto bg-slate-50 dark:bg-slate-950">
          {!currentTable ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              This base has no tables yet. Add one from the sidebar.
            </div>
          ) : contentLoading && !content ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : content ? (
            <Grid
              base={base}
              table={currentTable}
              tables={tables}
              content={content}
              onReload={() => loadContent(true)}
              onTablesReload={reloadActive}
              companyId={company.id}
            />
          ) : null}
        </div>
      </div>

      {showAssistant && (
        <BaseAssistant
          companyId={company.id}
          base={base}
          currentTable={currentTable}
          onClose={() => setShowAssistant(false)}
        />
      )}

      {showSettings && (
        <BaseSettingsModal
          company={company}
          base={base}
          onClose={() => setShowSettings(false)}
          onSaved={reloadActive}
          onDeleted={() => {
            setShowSettings(false);
            reloadBases();
            navigate(`/c/${company.slug}/bases`);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────── the grid ────────────────────────────────────────

function Grid({
  base,
  table,
  tables,
  content,
  onReload,
  onTablesReload,
  companyId,
}: {
  base: Base;
  table: BaseTable;
  tables: BaseTable[];
  content: BaseTableContent;
  onReload: () => Promise<void>;
  onTablesReload: () => Promise<void>;
  companyId: string;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const { fields, records, linkOptions } = content;
  const [pendingLinkField, setPendingLinkField] = React.useState<string | null>(null);

  async function patchCell(row: BaseRecord, fieldId: string, value: unknown) {
    // Optimistic: update in-place then re-fetch for link-label freshness.
    row.data[fieldId] = value as never;
    try {
      await api.patch(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/rows/${row.id}`,
        { fieldId, value },
      );
      await onReload();
    } catch (err) {
      toast((err as Error).message, "error");
      await onReload();
    }
  }

  async function addRow() {
    try {
      await api.post<BaseRecord>(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/rows`,
        { data: {} },
      );
      await onReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteRow(row: BaseRecord) {
    try {
      await api.del(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/rows/${row.id}`,
      );
      await onReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function addField(type: BaseFieldType) {
    if (type === "link") {
      // Link fields need both a name AND a target table — launch the richer
      // dedicated dialog below instead of two serial prompts.
      const choices = tables.filter((t) => t.id !== table.id);
      if (choices.length === 0) {
        await dialog.alert({
          title: "No table to link",
          message: "Add another table in this base first, then you can link to it.",
        });
        return;
      }
      setPendingLinkField("open");
      return;
    }
    const name = await dialog.prompt({
      title: `Add ${FIELD_TYPE_META[type].label.toLowerCase()} field`,
      placeholder: "Field name",
      defaultValue: FIELD_TYPE_META[type].label,
      confirmLabel: "Add field",
    });
    if (!name) return;
    const config: Record<string, unknown> = {};
    if (type === "select" || type === "multiselect") {
      config.options = [];
    }
    try {
      await api.post<BaseField>(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/fields`,
        { name, type, config },
      );
      await onReload();
      await onTablesReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function createLinkField(name: string, targetTableId: string) {
    try {
      await api.post<BaseField>(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/fields`,
        { name, type: "link", config: { targetTableId } },
      );
      await onReload();
      await onTablesReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function patchField(f: BaseField, patch: Partial<BaseField>) {
    try {
      await api.patch(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/fields/${f.id}`,
        patch,
      );
      await onReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteField(f: BaseField) {
    const ok = await dialog.confirm({
      title: `Delete "${f.name}"?`,
      message: "This column and all its values across every row will be removed.",
      confirmLabel: "Delete field",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(
        `/api/companies/${companyId}/bases/${base.slug}/tables/${table.id}/fields/${f.id}`,
      );
      await onReload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="inline-block min-w-full p-4">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-10 w-10 border-b border-r border-slate-200 bg-slate-50 px-2 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500">
                #
              </th>
              {fields.map((f) => (
                <FieldHeader
                  key={f.id}
                  field={f}
                  tables={tables}
                  onPatch={(p) => patchField(f, p)}
                  onDelete={() => deleteField(f)}
                />
              ))}
              <th className="border-b border-slate-200 bg-slate-50 px-1 py-1 dark:border-slate-700 dark:bg-slate-900">
                <AddFieldButton onAdd={addField} />
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, idx) => (
              <Row
                key={r.id}
                index={idx + 1}
                record={r}
                fields={fields}
                linkOptions={linkOptions}
                onPatchCell={(fid, v) => patchCell(r, fid, v)}
                onDelete={() => deleteRow(r)}
              />
            ))}
            <tr>
              <td className="sticky left-0 z-10 w-10 border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900" />
              <td
                colSpan={fields.length + 1}
                className="bg-slate-50 dark:bg-slate-900"
              >
                <button
                  onClick={addRow}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                >
                  <Plus size={12} /> Add row
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {records.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-slate-200 bg-white p-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          This table is empty. Click <span className="font-semibold">Add row</span> above to start.
        </div>
      )}

      {pendingLinkField && (
        <AddLinkFieldModal
          tables={tables.filter((t) => t.id !== table.id)}
          onCancel={() => setPendingLinkField(null)}
          onCreate={async (name, targetTableId) => {
            setPendingLinkField(null);
            await createLinkField(name, targetTableId);
          }}
        />
      )}
    </div>
  );
}

function AddLinkFieldModal({
  tables,
  onCancel,
  onCreate,
}: {
  tables: BaseTable[];
  onCancel: () => void;
  onCreate: (name: string, targetTableId: string) => void | Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [targetTableId, setTargetTableId] = React.useState(tables[0]?.id ?? "");

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canSubmit = name.trim() && targetTableId;

  return (
    <div
      onMouseDown={onCancel}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Add link field
          </h2>
          <button
            onClick={onCancel}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Field name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Company"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  void onCreate(name.trim(), targetTableId);
                }
              }}
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Link to table
            </label>
            <select
              value={targetTableId}
              onChange={(e) => setTargetTableId(e.target.value)}
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={() => void onCreate(name.trim(), targetTableId)}
            >
              Add field
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── row + cells ─────────────────────────────────────

function Row({
  index,
  record,
  fields,
  linkOptions,
  onPatchCell,
  onDelete,
}: {
  index: number;
  record: BaseRecord;
  fields: BaseField[];
  linkOptions: Record<string, BaseLinkOption[]>;
  onPatchCell: (fieldId: string, value: unknown) => void;
  onDelete: () => void;
}) {
  const [editingField, setEditingField] = React.useState<string | null>(null);

  return (
    <tr className="group border-t border-slate-100 hover:bg-indigo-50/20 dark:border-slate-800 dark:hover:bg-indigo-500/5">
      <td className="sticky left-0 z-10 w-10 border-r border-slate-200 bg-white px-2 text-center text-[11px] text-slate-400 group-hover:bg-indigo-50/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500">
        <div className="flex items-center justify-center gap-1">
          <span className="group-hover:hidden">{index}</span>
          <button
            onClick={onDelete}
            className="hidden rounded p-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 group-hover:inline-flex dark:hover:bg-red-950/30"
            title="Delete row"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </td>
      {fields.map((f) => {
        const editing = editingField === f.id;
        const value = record.data[f.id];
        return (
          <td
            key={f.id}
            className={clsx(
              "relative h-9 min-w-[140px] border-r border-slate-100 px-0 align-middle dark:border-slate-800",
              editing && "ring-2 ring-inset ring-indigo-400",
            )}
            onClick={() => {
              if (f.type === "checkbox") {
                onPatchCell(f.id, !value);
                return;
              }
              if (!editing) setEditingField(f.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Delete" || e.key === "Backspace") {
                if (editing) return;
                if (value !== undefined && value !== null && value !== "") {
                  onPatchCell(f.id, null);
                }
              }
            }}
            tabIndex={0}
          >
            {editing && f.type !== "checkbox" ? (
              <CellEditor
                field={f}
                value={value}
                linkOptionsByTable={linkOptions}
                autoFocus
                onCommit={(next) => onPatchCell(f.id, next)}
                onClose={() => setEditingField(null)}
              />
            ) : (
              <div className="flex h-full items-center px-2 text-sm">
                <CellView
                  field={f}
                  value={value}
                  linkOptionsByTable={linkOptions}
                />
              </div>
            )}
          </td>
        );
      })}
      <td />
    </tr>
  );
}

// ─────────────────────────── field header ────────────────────────────────────

function FieldHeader({
  field,
  tables,
  onPatch,
  onDelete,
}: {
  field: BaseField;
  tables: BaseTable[];
  onPatch: (p: Partial<BaseField>) => void;
  onDelete: () => void;
}) {
  const Meta = FIELD_TYPE_META[field.type];
  const Icon = Meta.icon;
  const targetTable = (() => {
    if (field.type !== "link") return null;
    const cfg = field.config as { targetTableId?: string };
    return tables.find((t) => t.id === cfg.targetTableId) ?? null;
  })();

  return (
    <th className="min-w-[140px] border-b border-r border-slate-200 bg-slate-50 px-0 text-left align-middle dark:border-slate-700 dark:bg-slate-900">
      <Menu
        width={280}
        align="left"
        trigger={({ ref, onClick, open }) => (
          <button
            ref={ref}
            onClick={onClick}
            className={clsx(
              "flex w-full items-center gap-1.5 px-2 py-2 text-left",
              open ? "bg-slate-100 dark:bg-slate-800" : "hover:bg-slate-100 dark:hover:bg-slate-800",
            )}
          >
            <Icon size={12} className="shrink-0 text-slate-500 dark:text-slate-400" />
            {field.isPrimary && (
              <Key size={10} className="shrink-0 text-amber-500" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
              {field.name}
            </span>
            <ChevronDown size={11} className="text-slate-400 dark:text-slate-500" />
          </button>
        )}
      >
        {(close) => (
          <FieldMenu
            field={field}
            targetTable={targetTable}
            onPatch={(p) => {
              onPatch(p);
            }}
            onDelete={() => {
              close();
              onDelete();
            }}
            onClose={close}
          />
        )}
      </Menu>
    </th>
  );
}

function FieldMenu({
  field,
  targetTable,
  onPatch,
  onDelete,
  onClose,
}: {
  field: BaseField;
  targetTable: BaseTable | null;
  onPatch: (p: Partial<BaseField>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(field.name);
  React.useEffect(() => setName(field.name), [field.id, field.name]);

  function saveName() {
    const n = name.trim();
    if (n && n !== field.name) onPatch({ name: n });
  }

  return (
    <div className="flex flex-col">
      <div className="p-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
              onClose();
            }
          }}
          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          {React.createElement(FIELD_TYPE_META[field.type].icon, { size: 10 })}
          {FIELD_TYPE_META[field.type].label}
          {field.type === "link" && targetTable && <span>→ {targetTable.name}</span>}
        </div>
      </div>
      <MenuSeparator />

      {(field.type === "select" || field.type === "multiselect") && (
        <div className="p-2">
          <MenuHeader>Options</MenuHeader>
          <SelectOptionsEditor
            options={(field.config as { options?: SelectOption[] })?.options ?? []}
            onChange={(opts) =>
              onPatch({ config: { ...field.config, options: opts } } as Partial<BaseField>)
            }
          />
        </div>
      )}

      {!field.isPrimary && (
        <MenuItem
          icon={<Key size={12} className="text-amber-500" />}
          label="Make primary"
          onSelect={() => {
            onPatch({ isPrimary: true });
            onClose();
          }}
        />
      )}
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 size={12} className="text-red-500" />}
        label={<span className="text-red-600">Delete field</span>}
        onSelect={onDelete}
      />
    </div>
  );
}

function AddFieldButton({ onAdd }: { onAdd: (t: BaseFieldType) => void }) {
  return (
    <Menu
      width={240}
      align="right"
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-8 w-full items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
            open && "bg-slate-100 dark:bg-slate-800",
          )}
          title="Add field"
        >
          <Plus size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Add field</MenuHeader>
          {(Object.keys(FIELD_TYPE_META) as BaseFieldType[]).map((t) => {
            const m = FIELD_TYPE_META[t];
            const Icon = m.icon;
            return (
              <MenuItem
                key={t}
                icon={<Icon size={12} />}
                label={<span>{m.label}</span>}
                hint={<span className="text-[10px]">{m.desc}</span>}
                onSelect={() => {
                  onAdd(t);
                  close();
                }}
              />
            );
          })}
        </>
      )}
    </Menu>
  );
}

// ─────────────────────────── settings modal ─────────────────────────────────

function BaseSettingsModal({
  company,
  base,
  onClose,
  onSaved,
  onDeleted,
}: {
  company: Company;
  base: Base;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [name, setName] = React.useState(base.name);
  const [description, setDescription] = React.useState(base.description);
  const [icon, setIcon] = React.useState(base.icon);
  const [color, setColor] = React.useState(base.color);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<"general" | "access">("general");

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/api/companies/${company.id}/bases/${base.slug}`, {
        name,
        description,
        icon,
        color,
      });
      await onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await dialog.confirm({
      title: `Delete "${base.name}"?`,
      message: "Every table, field, and row in this base will be permanently removed.",
      confirmLabel: "Delete base",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`/api/companies/${company.id}/bases/${base.slug}`);
      onDeleted();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Base settings
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex gap-1 border-b border-slate-100 px-5 dark:border-slate-800">
          <TabButton active={tab === "general"} onClick={() => setTab("general")}>
            General
          </TabButton>
          <TabButton active={tab === "access"} onClick={() => setTab("access")}>
            <Users size={12} /> AI access
          </TabButton>
        </div>

        {tab === "general" ? (
          <div className="flex flex-col gap-4 p-5">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Icon
              </span>
              <div className="flex flex-wrap gap-1.5">
                {BASE_ICON_NAMES.map((n) => (
                  <button
                    key={n}
                    onClick={() => setIcon(n)}
                    className={clsx(
                      "flex h-8 w-8 items-center justify-center rounded-md border",
                      icon === n
                        ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
                    )}
                    title={n}
                  >
                    <BaseIcon name={n} size={14} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Color
              </span>
              <div className="flex flex-wrap gap-1.5">
                {BASE_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={clsx(
                      "flex h-8 w-8 items-center justify-center rounded-md border",
                      color === c
                        ? "border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-800"
                        : "border-slate-200 dark:border-slate-700",
                      baseAccent(c, "tile"),
                    )}
                    title={c}
                  >
                    <BaseIcon name={icon} size={12} />
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between">
              <Button variant="danger" onClick={remove} disabled={busy}>
                <Trash2 size={14} /> Delete base
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={save} disabled={busy || !name.trim()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <BaseAccessTab company={company} base={base} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition",
        active
          ? "border-indigo-500 text-indigo-700 dark:text-indigo-300"
          : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
      )}
    >
      {children}
    </button>
  );
}

function BaseAccessTab({
  company,
  base,
  onClose,
}: {
  company: Company;
  base: Base;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [grants, setGrants] = React.useState<BaseGrant[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [picker, setPicker] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const [g, emps] = await Promise.all([
        api.get<BaseGrant[]>(
          `/api/companies/${company.id}/bases/${base.slug}/grants`,
        ),
        api.get<Employee[]>(`/api/companies/${company.id}/employees`),
      ]);
      setGrants(g);
      setEmployees(emps);
    } catch (err) {
      toast((err as Error).message, "error");
      setGrants([]);
    }
  }, [base.slug, company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const grantedIds = React.useMemo(
    () => new Set((grants ?? []).map((g) => g.employeeId)),
    [grants],
  );
  const grantable = React.useMemo(
    () => employees.filter((e) => !grantedIds.has(e.id)),
    [employees, grantedIds],
  );

  async function grant(emp: Employee) {
    try {
      await api.post<BaseGrant>(
        `/api/companies/${company.id}/bases/${base.slug}/grants`,
        { employeeId: emp.id },
      );
      toast(`Granted ${emp.name}`, "success");
      setPicker(false);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function revoke(g: BaseGrant) {
    const ok = await dialog.confirm({
      title: `Revoke ${g.employee?.name ?? "employee"}?`,
      message: `They lose access to this base on their next spawn.`,
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(
        `/api/companies/${company.id}/bases/${base.slug}/grants/${g.employeeId}`,
      );
      setGrants((prev) => (prev ?? []).filter((x) => x.id !== g.id));
      toast("Revoked", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          AI employees with access
        </h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Granted employees can read and write records in this base through
          their MCP tools on their next spawn.
        </p>
      </div>

      {grants === null ? (
        <div className="flex justify-center py-6">
          <Spinner size={16} />
        </div>
      ) : grants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No AI employees can access this base yet.
          </p>
          <Button
            size="sm"
            onClick={() => setPicker(true)}
            disabled={employees.length === 0}
            className="mt-2"
          >
            Grant access
          </Button>
          {employees.length === 0 && (
            <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
              Hire an AI employee first.
            </p>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-3 py-2">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {(g.employee?.name ?? "?").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {g.employee?.name ?? "Unknown"}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {g.employee?.role ?? ""}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => revoke(g)}>
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {grants !== null && grants.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setPicker(true)}
          disabled={grantable.length === 0}
        >
          <Plus size={12} /> Grant to another employee
        </Button>
      )}

      <div className="flex justify-end border-t border-slate-100 pt-3 dark:border-slate-800">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>

      {picker && (
        <EmployeePickerModal
          employees={grantable}
          onCancel={() => setPicker(false)}
          onPick={grant}
        />
      )}
    </div>
  );
}

function EmployeePickerModal({
  employees,
  onCancel,
  onPick,
}: {
  employees: Employee[];
  onCancel: () => void;
  onPick: (e: Employee) => void;
}) {
  return (
    <div
      onMouseDown={onCancel}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Grant access
          </h3>
          <button
            onClick={onCancel}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-3">
          {employees.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-slate-500 dark:text-slate-400">
              Every AI employee already has access.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {employees.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => onPick(e)}
                    className="flex w-full items-center gap-3 rounded-lg border border-slate-200 p-2.5 text-left hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
                  >
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {e.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {e.name}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {e.role}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
