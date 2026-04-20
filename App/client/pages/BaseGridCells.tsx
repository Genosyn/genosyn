import React from "react";
import { Check, ChevronDown, X, Link as LinkIcon, Plus } from "lucide-react";
import {
  BaseField,
  BaseLinkOption,
  SelectOption,
} from "../lib/api";
import { Menu, MenuHeader, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { chipClass } from "../components/BaseIcons";
import { clsx } from "../components/ui/clsx";

/**
 * Inline cell editors for each BaseField type. Each editor owns its own
 * editing state and commits on blur / enter. Parent passes the raw cell value
 * from record.data[fieldId] and a commit callback.
 */

export type CellEditorProps = {
  field: BaseField;
  value: unknown;
  /** Full `{fieldId: value}` row, so link editors can render primaries etc. */
  linkOptionsByTable: Record<string, BaseLinkOption[]>;
  onCommit: (next: unknown) => void;
  autoFocus?: boolean;
};

export function CellView({
  field,
  value,
  linkOptionsByTable,
}: {
  field: BaseField;
  value: unknown;
  linkOptionsByTable: Record<string, BaseLinkOption[]>;
}) {
  switch (field.type) {
    case "checkbox":
      return (
        <div className="flex h-full items-center">
          <div
            className={clsx(
              "flex h-4 w-4 items-center justify-center rounded border",
              value
                ? "border-indigo-500 bg-indigo-500 text-white"
                : "border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800",
            )}
          >
            {value ? <Check size={12} strokeWidth={3} /> : null}
          </div>
        </div>
      );
    case "select": {
      const opts = readSelectOptions(field);
      const id = typeof value === "string" ? value : null;
      const opt = id ? opts.find((o) => o.id === id) : null;
      if (!opt) return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return (
        <span className={clsx("inline-block rounded px-1.5 py-0.5 text-xs", chipClass(opt.color))}>
          {opt.label}
        </span>
      );
    }
    case "multiselect": {
      const opts = readSelectOptions(field);
      const ids = Array.isArray(value) ? (value as string[]) : [];
      if (ids.length === 0) return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => {
            const o = opts.find((x) => x.id === id);
            if (!o) return null;
            return (
              <span
                key={id}
                className={clsx("rounded px-1.5 py-0.5 text-[11px]", chipClass(o.color))}
              >
                {o.label}
              </span>
            );
          })}
        </div>
      );
    }
    case "link": {
      const cfg = field.config as { targetTableId?: string };
      const opts = cfg.targetTableId ? linkOptionsByTable[cfg.targetTableId] ?? [] : [];
      const ids = Array.isArray(value) ? (value as string[]) : [];
      if (ids.length === 0)
        return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => {
            const o = opts.find((x) => x.id === id);
            const label = o?.label ?? "(missing)";
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                <LinkIcon size={10} /> {label}
              </span>
            );
          })}
        </div>
      );
    }
    case "number": {
      const n = typeof value === "number" ? value : null;
      return (
        <span className="tabular-nums text-slate-800 dark:text-slate-100">
          {n === null ? (
            <span className="text-slate-400 dark:text-slate-600">—</span>
          ) : (
            n
          )}
        </span>
      );
    }
    case "date":
    case "datetime": {
      if (typeof value !== "string" || !value)
        return <span className="text-slate-400 dark:text-slate-600">—</span>;
      const d = new Date(value);
      if (Number.isNaN(d.getTime()))
        return <span className="text-slate-400 dark:text-slate-600">{value}</span>;
      return (
        <span className="text-slate-800 dark:text-slate-100">
          {field.type === "date"
            ? d.toLocaleDateString()
            : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
        </span>
      );
    }
    case "email":
    case "url": {
      if (typeof value !== "string" || !value)
        return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return (
        <span className="truncate text-slate-800 dark:text-slate-100">{value}</span>
      );
    }
    case "longtext": {
      if (typeof value !== "string" || !value)
        return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return (
        <span className="line-clamp-1 text-slate-800 dark:text-slate-100">{value}</span>
      );
    }
    default:
      if (typeof value !== "string" || !value)
        return <span className="text-slate-400 dark:text-slate-600">—</span>;
      return <span className="truncate text-slate-800 dark:text-slate-100">{value}</span>;
  }
}

export function CellEditor({
  field,
  value,
  linkOptionsByTable,
  onCommit,
  autoFocus,
  onClose,
}: CellEditorProps & { onClose: () => void }) {
  switch (field.type) {
    case "longtext":
      return (
        <TextAreaEditor
          value={typeof value === "string" ? value : ""}
          onCommit={(v) => {
            onCommit(v);
            onClose();
          }}
          autoFocus={autoFocus}
        />
      );
    case "number":
      return (
        <NumberEditor
          value={typeof value === "number" ? value : null}
          onCommit={(v) => {
            onCommit(v);
            onClose();
          }}
          autoFocus={autoFocus}
        />
      );
    case "date":
    case "datetime":
      return (
        <DateEditor
          type={field.type}
          value={typeof value === "string" ? value : ""}
          onCommit={(v) => {
            onCommit(v);
            onClose();
          }}
          autoFocus={autoFocus}
        />
      );
    case "select":
      return (
        <SelectEditor
          field={field}
          value={typeof value === "string" ? value : null}
          onCommit={(v) => {
            onCommit(v);
            onClose();
          }}
        />
      );
    case "multiselect":
      return (
        <MultiSelectEditor
          field={field}
          value={Array.isArray(value) ? (value as string[]) : []}
          onCommit={(v) => onCommit(v)}
          onClose={onClose}
        />
      );
    case "link":
      return (
        <LinkEditor
          field={field}
          value={Array.isArray(value) ? (value as string[]) : []}
          linkOptionsByTable={linkOptionsByTable}
          onCommit={(v) => onCommit(v)}
          onClose={onClose}
        />
      );
    default:
      return (
        <TextEditor
          type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
          value={typeof value === "string" ? value : ""}
          onCommit={(v) => {
            onCommit(v);
            onClose();
          }}
          autoFocus={autoFocus}
        />
      );
  }
}

function TextEditor({
  value,
  onCommit,
  autoFocus,
  type,
}: {
  value: string;
  onCommit: (v: string) => void;
  autoFocus?: boolean;
  type: "text" | "email" | "url";
}) {
  const [v, setV] = React.useState(value);
  return (
    <input
      autoFocus={autoFocus}
      type={type}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onCommit(value);
      }}
      className="h-full w-full bg-white px-2 text-sm text-slate-900 outline-none ring-2 ring-indigo-400 dark:bg-slate-950 dark:text-slate-100"
    />
  );
}

function TextAreaEditor({
  value,
  onCommit,
  autoFocus,
}: {
  value: string;
  onCommit: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [v, setV] = React.useState(value);
  return (
    <textarea
      autoFocus={autoFocus}
      rows={3}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
          (e.target as HTMLTextAreaElement).blur();
        if (e.key === "Escape") onCommit(value);
      }}
      className="block h-24 w-full resize-none bg-white px-2 py-1 text-sm text-slate-900 outline-none ring-2 ring-indigo-400 dark:bg-slate-950 dark:text-slate-100"
    />
  );
}

function NumberEditor({
  value,
  onCommit,
  autoFocus,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  autoFocus?: boolean;
}) {
  const [v, setV] = React.useState(value === null ? "" : String(value));
  return (
    <input
      autoFocus={autoFocus}
      inputMode="decimal"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v === "" ? null : Number(v))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onCommit(value);
      }}
      className="h-full w-full bg-white px-2 text-right text-sm tabular-nums text-slate-900 outline-none ring-2 ring-indigo-400 dark:bg-slate-950 dark:text-slate-100"
    />
  );
}

function DateEditor({
  type,
  value,
  onCommit,
  autoFocus,
}: {
  type: "date" | "datetime";
  value: string;
  onCommit: (v: string | null) => void;
  autoFocus?: boolean;
}) {
  const [v, setV] = React.useState(() => normalizeDateInput(value, type));
  return (
    <input
      autoFocus={autoFocus}
      type={type === "date" ? "date" : "datetime-local"}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onCommit(value || null);
      }}
      className="h-full w-full bg-white px-2 text-sm text-slate-900 outline-none ring-2 ring-indigo-400 dark:bg-slate-950 dark:text-slate-100"
    />
  );
}

function normalizeDateInput(value: string, type: "date" | "datetime"): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  if (type === "date") return d.toISOString().slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function SelectEditor({
  field,
  value,
  onCommit,
}: {
  field: BaseField;
  value: string | null;
  onCommit: (v: string | null) => void;
}) {
  const opts = readSelectOptions(field);
  return (
    <div className="flex max-h-64 flex-col overflow-y-auto bg-white py-1 dark:bg-slate-900">
      <button
        onClick={() => onCommit(null)}
        className="flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        <X size={12} className="text-slate-400 dark:text-slate-500" />
        <span className="text-slate-500 dark:text-slate-400">Clear</span>
      </button>
      {opts.length === 0 ? (
        <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
          No options. Add some from the field menu.
        </div>
      ) : (
        opts.map((o) => (
          <button
            key={o.id}
            onClick={() => onCommit(o.id)}
            className={clsx(
              "flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800",
              value === o.id && "bg-indigo-50 dark:bg-indigo-500/10",
            )}
          >
            <span className={clsx("rounded px-1.5 py-0.5 text-xs", chipClass(o.color))}>
              {o.label}
            </span>
            {value === o.id && (
              <Check size={12} className="ml-auto text-indigo-600 dark:text-indigo-400" />
            )}
          </button>
        ))
      )}
    </div>
  );
}

function MultiSelectEditor({
  field,
  value,
  onCommit,
  onClose,
}: {
  field: BaseField;
  value: string[];
  onCommit: (v: string[]) => void;
  onClose: () => void;
}) {
  const opts = readSelectOptions(field);
  const [local, setLocal] = React.useState<string[]>(value);

  function toggle(id: string) {
    const next = local.includes(id) ? local.filter((x) => x !== id) : [...local, id];
    setLocal(next);
    onCommit(next);
  }

  return (
    <div className="flex max-h-64 flex-col overflow-y-auto bg-white py-1 dark:bg-slate-900">
      <div className="flex items-center justify-between px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        <span>Select multiple</span>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          aria-label="Done"
        >
          Done
        </button>
      </div>
      {opts.length === 0 ? (
        <div className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
          No options. Add some from the field menu.
        </div>
      ) : (
        opts.map((o) => {
          const on = local.includes(o.id);
          return (
            <button
              key={o.id}
              onClick={() => toggle(o.id)}
              className={clsx(
                "flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800",
              )}
            >
              <span
                className={clsx(
                  "flex h-3.5 w-3.5 items-center justify-center rounded border",
                  on
                    ? "border-indigo-500 bg-indigo-500 text-white"
                    : "border-slate-300 dark:border-slate-600",
                )}
              >
                {on && <Check size={10} strokeWidth={3} />}
              </span>
              <span className={clsx("rounded px-1.5 py-0.5 text-xs", chipClass(o.color))}>
                {o.label}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

function LinkEditor({
  field,
  value,
  linkOptionsByTable,
  onCommit,
  onClose,
}: {
  field: BaseField;
  value: string[];
  linkOptionsByTable: Record<string, BaseLinkOption[]>;
  onCommit: (v: string[]) => void;
  onClose: () => void;
}) {
  const cfg = field.config as { targetTableId?: string };
  const opts = cfg.targetTableId ? linkOptionsByTable[cfg.targetTableId] ?? [] : [];
  const [local, setLocal] = React.useState<string[]>(value);
  const [query, setQuery] = React.useState("");

  function toggle(id: string) {
    const next = local.includes(id) ? local.filter((x) => x !== id) : [...local, id];
    setLocal(next);
    onCommit(next);
  }

  const filtered = query
    ? opts.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : opts;

  return (
    <div className="flex max-h-80 flex-col bg-white dark:bg-slate-900">
      <div className="flex items-center gap-1 border-b border-slate-100 p-1 dark:border-slate-800">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search records…"
          className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-sm placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:outline-none dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
        />
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
        >
          Done
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-slate-400 dark:text-slate-500">
            {query ? "No matches" : "No records in the linked table yet."}
          </div>
        ) : (
          filtered.map((o) => {
            const on = local.includes(o.id);
            return (
              <button
                key={o.id}
                onClick={() => toggle(o.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span
                  className={clsx(
                    "flex h-3.5 w-3.5 items-center justify-center rounded border",
                    on
                      ? "border-indigo-500 bg-indigo-500 text-white"
                      : "border-slate-300 dark:border-slate-600",
                  )}
                >
                  {on && <Check size={10} strokeWidth={3} />}
                </span>
                <LinkIcon size={11} className="text-slate-400 dark:text-slate-500" />
                <span className="truncate text-slate-800 dark:text-slate-100">{o.label}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function readSelectOptions(field: BaseField): SelectOption[] {
  const raw = (field.config as { options?: SelectOption[] })?.options;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Small editor for the "options" of a select/multiselect field. Used inside
 * the field settings menu. Lets the user rename and color each option.
 */
export function SelectOptionsEditor({
  options,
  onChange,
}: {
  options: SelectOption[];
  onChange: (next: SelectOption[]) => void;
}) {
  const [draft, setDraft] = React.useState(options);
  React.useEffect(() => setDraft(options), [options]);

  function addOption() {
    const next = [
      ...draft,
      { id: Math.random().toString(36).slice(2, 10), label: "New", color: "slate" },
    ];
    setDraft(next);
    onChange(next);
  }
  function update(id: string, patch: Partial<SelectOption>) {
    const next = draft.map((o) => (o.id === id ? { ...o, ...patch } : o));
    setDraft(next);
    onChange(next);
  }
  function remove(id: string) {
    const next = draft.filter((o) => o.id !== id);
    setDraft(next);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {draft.map((o) => (
        <div key={o.id} className="flex items-center gap-1.5">
          <Menu
            width={120}
            trigger={({ ref, onClick, open }) => (
              <button
                ref={ref}
                onClick={onClick}
                className={clsx(
                  "flex h-6 w-6 items-center justify-center rounded-md border",
                  open
                    ? "border-indigo-400"
                    : "border-slate-200 dark:border-slate-700",
                )}
                title="Change color"
              >
                <span
                  className={clsx("h-3 w-3 rounded", chipClass(o.color))}
                />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuHeader>Color</MenuHeader>
                {[
                  "indigo",
                  "emerald",
                  "amber",
                  "rose",
                  "sky",
                  "violet",
                  "slate",
                ].map((c) => (
                  <MenuItem
                    key={c}
                    label={
                      <span
                        className={clsx("inline-block rounded px-1.5 py-0.5 text-xs", chipClass(c))}
                      >
                        {c}
                      </span>
                    }
                    onSelect={() => {
                      update(o.id, { color: c });
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </Menu>
          <input
            value={o.label}
            onChange={(e) => update(o.id, { label: e.target.value })}
            className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            onClick={() => remove(o.id)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
            aria-label="Remove"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={addOption}
        className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-200 px-2 py-1 text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600 dark:border-slate-700"
      >
        <Plus size={12} /> Add option
      </button>
    </div>
  );
}

/** Tiny chevron-style trigger reused by a couple of pickers. */
export function TriggerChevron() {
  return <ChevronDown size={11} className="text-slate-400 dark:text-slate-500" />;
}
