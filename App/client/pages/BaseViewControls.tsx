import React from "react";
import {
  Plus,
  X,
  Filter as FilterIcon,
  ArrowUpDown,
  EyeOff,
  Check,
  ChevronDown,
} from "lucide-react";
import {
  BaseField,
  BaseFieldType,
  BaseFilterOperator,
  BaseFilterRule,
  BaseLinkOption,
  BaseRecord,
  BaseSortRule,
  SelectOption,
} from "../lib/api";
import { Menu } from "../components/ui/Menu";
import { clsx } from "../components/ui/clsx";
import { chipClass } from "../components/BaseIcons";

/**
 * View controls for a Base table: filter rules, sort rules, and field
 * visibility. Each control is a toolbar button that opens a popover. Filtering
 * and sorting are evaluated client-side against the already-loaded records,
 * so changes feel instant — the active view's rule list is the single source
 * of truth, persisted to the server when the user commits an edit.
 *
 * Filter operators are gated by field type. The same picker drives every
 * field, but only operators that make sense for the chosen field's type are
 * offered. The full set of evaluators lives in `recordMatchesRule` below.
 */

// ───────────────────── operator catalogue ────────────────────────────────────

type OperatorMeta = {
  op: BaseFilterOperator;
  label: string;
  /** True when no `value` is needed (e.g. `isEmpty`, `isChecked`). */
  unary?: boolean;
};

const OPERATORS_BY_TYPE: Record<BaseFieldType, OperatorMeta[]> = {
  text: [
    { op: "contains", label: "contains" },
    { op: "doesNotContain", label: "does not contain" },
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  longtext: [
    { op: "contains", label: "contains" },
    { op: "doesNotContain", label: "does not contain" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  email: [
    { op: "contains", label: "contains" },
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  url: [
    { op: "contains", label: "contains" },
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  number: [
    { op: "equals", label: "=" },
    { op: "notEquals", label: "≠" },
    { op: "greaterThan", label: ">" },
    { op: "lessThan", label: "<" },
    { op: "greaterThanOrEqual", label: "≥" },
    { op: "lessThanOrEqual", label: "≤" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  checkbox: [
    { op: "isChecked", label: "is checked", unary: true },
    { op: "isUnchecked", label: "is unchecked", unary: true },
  ],
  date: [
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isBefore", label: "is before" },
    { op: "isAfter", label: "is after" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  datetime: [
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isBefore", label: "is before" },
    { op: "isAfter", label: "is after" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  select: [
    { op: "is", label: "is" },
    { op: "isNot", label: "is not" },
    { op: "isAnyOf", label: "is any of" },
    { op: "isNoneOf", label: "is none of" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  multiselect: [
    { op: "hasAnyOf", label: "has any of" },
    { op: "hasAllOf", label: "has all of" },
    { op: "hasNoneOf", label: "has none of" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
  link: [
    { op: "hasAnyOf", label: "has any of" },
    { op: "hasNoneOf", label: "has none of" },
    { op: "isEmpty", label: "is empty", unary: true },
    { op: "isNotEmpty", label: "is not empty", unary: true },
  ],
};

export function defaultOperatorFor(type: BaseFieldType): BaseFilterOperator {
  return OPERATORS_BY_TYPE[type][0]?.op ?? "isEmpty";
}

export function isUnaryOperator(op: BaseFilterOperator): boolean {
  return (
    op === "isEmpty" ||
    op === "isNotEmpty" ||
    op === "isChecked" ||
    op === "isUnchecked"
  );
}

// ───────────────────── evaluator (filter + sort) ─────────────────────────────

function isCellEmpty(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === "string" && val === "") return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function asLowerString(v: unknown): string | null {
  return typeof v === "string" ? v.toLowerCase() : null;
}

function recordMatchesRule(
  record: BaseRecord,
  rule: BaseFilterRule,
  field: BaseField,
): boolean {
  const val = record.data[rule.fieldId];

  switch (rule.operator) {
    case "isEmpty":
      return isCellEmpty(val);
    case "isNotEmpty":
      return !isCellEmpty(val);
    case "isChecked":
      return !!val;
    case "isUnchecked":
      return !val;

    case "is":
    case "equals": {
      if (field.type === "number") {
        return typeof val === "number" && val === Number(rule.value);
      }
      const a = asLowerString(val);
      const b = asLowerString(rule.value);
      if (a !== null && b !== null) return a === b;
      return val === rule.value;
    }
    case "isNot":
    case "notEquals": {
      if (isCellEmpty(val)) return true;
      if (field.type === "number") {
        return typeof val === "number" && val !== Number(rule.value);
      }
      const a = asLowerString(val);
      const b = asLowerString(rule.value);
      if (a !== null && b !== null) return a !== b;
      return val !== rule.value;
    }

    case "contains": {
      const a = asLowerString(val);
      const b = asLowerString(rule.value);
      if (a === null || b === null) return false;
      return a.includes(b);
    }
    case "doesNotContain": {
      const a = asLowerString(val);
      const b = asLowerString(rule.value);
      if (b === null) return true;
      if (a === null) return true;
      return !a.includes(b);
    }

    case "greaterThan":
      return typeof val === "number" && val > Number(rule.value);
    case "lessThan":
      return typeof val === "number" && val < Number(rule.value);
    case "greaterThanOrEqual":
      return typeof val === "number" && val >= Number(rule.value);
    case "lessThanOrEqual":
      return typeof val === "number" && val <= Number(rule.value);

    case "isAnyOf": {
      if (!Array.isArray(rule.value)) return false;
      return (rule.value as unknown[]).includes(val);
    }
    case "isNoneOf": {
      if (!Array.isArray(rule.value)) return true;
      return !(rule.value as unknown[]).includes(val);
    }
    case "hasAnyOf": {
      if (!Array.isArray(rule.value) || !Array.isArray(val)) return false;
      return (rule.value as unknown[]).some((v) => (val as unknown[]).includes(v));
    }
    case "hasAllOf": {
      if (!Array.isArray(rule.value) || !Array.isArray(val)) return false;
      return (rule.value as unknown[]).every((v) =>
        (val as unknown[]).includes(v),
      );
    }
    case "hasNoneOf": {
      if (!Array.isArray(rule.value)) return true;
      if (!Array.isArray(val)) return true;
      return !(rule.value as unknown[]).some((v) =>
        (val as unknown[]).includes(v),
      );
    }

    case "isBefore": {
      if (typeof val !== "string" || typeof rule.value !== "string") return false;
      const a = new Date(val).getTime();
      const b = new Date(rule.value).getTime();
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a < b;
    }
    case "isAfter": {
      if (typeof val !== "string" || typeof rule.value !== "string") return false;
      const a = new Date(val).getTime();
      const b = new Date(rule.value).getTime();
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return a > b;
    }

    default:
      return true;
  }
}

export function applyFilters(
  records: BaseRecord[],
  filters: BaseFilterRule[],
  fields: BaseField[],
): BaseRecord[] {
  if (filters.length === 0) return records;
  const fieldById = new Map(fields.map((f) => [f.id, f] as const));
  return records.filter((r) =>
    filters.every((rule) => {
      const f = fieldById.get(rule.fieldId);
      if (!f) return true; // tolerate stale rules referencing deleted fields
      return recordMatchesRule(r, rule, f);
    }),
  );
}

function compareValues(
  a: unknown,
  b: unknown,
  type: BaseFieldType,
): number {
  const aEmpty = isCellEmpty(a);
  const bEmpty = isCellEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // empties sink to the bottom regardless of direction
  if (bEmpty) return -1;

  if (type === "number") {
    const an = typeof a === "number" ? a : Number(a);
    const bn = typeof b === "number" ? b : Number(b);
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return an - bn;
  }
  if (type === "checkbox") {
    return Number(!!a) - Number(!!b);
  }
  if (type === "date" || type === "datetime") {
    const at = typeof a === "string" ? new Date(a).getTime() : 0;
    const bt = typeof b === "string" ? new Date(b).getTime() : 0;
    return at - bt;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const ax = Array.isArray(a) ? a.join(",") : String(a ?? "");
    const bx = Array.isArray(b) ? b.join(",") : String(b ?? "");
    return ax.localeCompare(bx);
  }
  const ax = String(a ?? "");
  const bx = String(b ?? "");
  return ax.localeCompare(bx, undefined, { sensitivity: "base" });
}

export function applySorts(
  records: BaseRecord[],
  sorts: BaseSortRule[],
  fields: BaseField[],
): BaseRecord[] {
  if (sorts.length === 0) return records;
  const fieldById = new Map(fields.map((f) => [f.id, f] as const));
  // Stable sort copy — slice first so callers' original array is preserved.
  return records.slice().sort((a, b) => {
    for (const s of sorts) {
      const f = fieldById.get(s.fieldId);
      if (!f) continue;
      const cmp = compareValues(a.data[s.fieldId], b.data[s.fieldId], f.type);
      if (cmp !== 0) return s.direction === "asc" ? cmp : -cmp;
    }
    return a.sortOrder - b.sortOrder;
  });
}

// ───────────────────── shared shell for popovers ─────────────────────────────

function ToolbarPopover({
  open,
  onClose,
  triggerRef,
  width = 360,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  width?: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const top = r.bottom + 6;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setCoords({ top, left });
  }, [open, triggerRef, width]);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !coords) return null;
  return (
    <div
      ref={ref}
      style={{ top: coords.top, left: coords.left, width }}
      className="fixed z-50 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      role="dialog"
    >
      {children}
    </div>
  );
}

export function ToolbarButton({
  active,
  count,
  icon,
  label,
  onClick,
  buttonRef,
}: {
  active?: boolean;
  count?: number;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition",
        active
          ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:border-indigo-800 dark:text-indigo-300"
          : "border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
    >
      {icon}
      <span>{label}</span>
      {count ? (
        <span
          className={clsx(
            "rounded-full px-1.5 text-[10px] font-semibold",
            active
              ? "bg-indigo-200 text-indigo-800 dark:bg-indigo-700/40 dark:text-indigo-200"
              : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

// ───────────────────── filter popover ────────────────────────────────────────

export function FilterPopover({
  open,
  onClose,
  triggerRef,
  fields,
  filters,
  onChange,
  linkOptions,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  fields: BaseField[];
  filters: BaseFilterRule[];
  onChange: (next: BaseFilterRule[]) => void;
  linkOptions: Record<string, BaseLinkOption[]>;
}) {
  function addRule() {
    const f = fields[0];
    if (!f) return;
    onChange([
      ...filters,
      {
        id: Math.random().toString(36).slice(2, 10),
        fieldId: f.id,
        operator: defaultOperatorFor(f.type),
        value: undefined,
      },
    ]);
  }

  function updateRule(id: string, patch: Partial<BaseFilterRule>) {
    onChange(filters.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRule(id: string) {
    onChange(filters.filter((r) => r.id !== id));
  }

  return (
    <ToolbarPopover open={open} onClose={onClose} triggerRef={triggerRef} width={520}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Filters
        </span>
        {filters.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="text-[11px] text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400"
          >
            Clear all
          </button>
        )}
      </div>
      {filters.length === 0 ? (
        <p className="px-1 py-3 text-xs text-slate-500 dark:text-slate-400">
          No filters yet. Add one to narrow the rows shown in this view.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {filters.map((rule, i) => {
            const field = fields.find((f) => f.id === rule.fieldId) ?? fields[0];
            return (
              <li key={rule.id} className="flex items-center gap-1.5">
                <span className="w-12 shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
                  {i === 0 ? "Where" : "And"}
                </span>
                <FieldPicker
                  fields={fields}
                  value={rule.fieldId}
                  onChange={(fid) => {
                    const next = fields.find((f) => f.id === fid)!;
                    updateRule(rule.id, {
                      fieldId: fid,
                      operator: defaultOperatorFor(next.type),
                      value: undefined,
                    });
                  }}
                />
                <OperatorPicker
                  field={field}
                  value={rule.operator}
                  onChange={(op) =>
                    updateRule(rule.id, {
                      operator: op,
                      value: isUnaryOperator(op) ? undefined : rule.value,
                    })
                  }
                />
                {!isUnaryOperator(rule.operator) && (
                  <FilterValueEditor
                    field={field}
                    operator={rule.operator}
                    value={rule.value}
                    linkOptions={linkOptions}
                    onChange={(v) => updateRule(rule.id, { value: v })}
                  />
                )}
                <button
                  onClick={() => removeRule(rule.id)}
                  className="ml-auto rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                  aria-label="Remove filter"
                >
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        onClick={addRule}
        disabled={fields.length === 0}
        className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
      >
        <Plus size={11} /> Add filter
      </button>
    </ToolbarPopover>
  );
}

function FieldPicker({
  fields,
  value,
  onChange,
}: {
  fields: BaseField[];
  value: string;
  onChange: (id: string) => void;
}) {
  const current = fields.find((f) => f.id === value);
  return (
    <Menu
      width={200}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-7 min-w-0 max-w-[120px] items-center gap-1 rounded border px-2 text-xs",
            open
              ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
          )}
        >
          <span className="truncate text-slate-700 dark:text-slate-200">
            {current?.name ?? "Field"}
          </span>
          <ChevronDown size={11} className="shrink-0 text-slate-400" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-64 overflow-y-auto">
          {fields.map((f) => (
            <button
              key={f.id}
              onClick={() => {
                onChange(f.id);
                close();
              }}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                value === f.id
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
              )}
            >
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

function OperatorPicker({
  field,
  value,
  onChange,
}: {
  field: BaseField;
  value: BaseFilterOperator;
  onChange: (op: BaseFilterOperator) => void;
}) {
  const options = OPERATORS_BY_TYPE[field.type] ?? [];
  const current = options.find((o) => o.op === value) ?? options[0];

  return (
    <Menu
      width={200}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-7 min-w-0 items-center gap-1 rounded border px-2 text-xs",
            open
              ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
          )}
        >
          <span className="truncate text-slate-700 dark:text-slate-200">
            {current?.label ?? value}
          </span>
          <ChevronDown size={11} className="shrink-0 text-slate-400" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-64 overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.op}
              onClick={() => {
                onChange(o.op);
                close();
              }}
              className={clsx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                value === o.op
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

function FilterValueEditor({
  field,
  operator,
  value,
  linkOptions,
  onChange,
}: {
  field: BaseField;
  operator: BaseFilterOperator;
  value: unknown;
  linkOptions: Record<string, BaseLinkOption[]>;
  onChange: (v: unknown) => void;
}) {
  // Multi-select operators take an array of ids.
  const multiOp =
    operator === "isAnyOf" ||
    operator === "isNoneOf" ||
    operator === "hasAnyOf" ||
    operator === "hasAllOf" ||
    operator === "hasNoneOf";

  if (field.type === "select" || field.type === "multiselect") {
    const opts = (field.config as { options?: SelectOption[] })?.options ?? [];
    if (multiOp) {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return <SelectChipList options={opts} value={arr} onChange={onChange} />;
    }
    return (
      <SingleSelectPicker options={opts} value={typeof value === "string" ? value : null} onChange={onChange} />
    );
  }

  if (field.type === "link") {
    const cfg = field.config as { targetTableId?: string };
    const opts = cfg.targetTableId ? linkOptions[cfg.targetTableId] ?? [] : [];
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <LinkChipList
        options={opts.map((o) => ({ id: o.id, label: o.label }))}
        value={arr}
        onChange={onChange}
      />
    );
  }

  if (field.type === "number") {
    return (
      <input
        type="number"
        value={typeof value === "number" ? value : value === undefined ? "" : String(value)}
        onChange={(e) => {
          const n = e.target.value === "" ? undefined : Number(e.target.value);
          onChange(n);
        }}
        placeholder="Value"
        className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
    );
  }

  if (field.type === "date" || field.type === "datetime") {
    return (
      <input
        type={field.type === "date" ? "date" : "datetime-local"}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
    );
  }

  return (
    <input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Value"
      className="h-7 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-900 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    />
  );
}

function SingleSelectPicker({
  options,
  value,
  onChange,
}: {
  options: SelectOption[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <Menu
      width={200}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-7 min-w-0 flex-1 items-center gap-1 rounded border px-2 text-xs",
            open
              ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
          )}
        >
          {current ? (
            <span className={clsx("rounded px-1.5 py-0.5 text-[11px]", chipClass(current.color))}>
              {current.label}
            </span>
          ) : (
            <span className="truncate text-slate-400">Pick option</span>
          )}
          <ChevronDown size={11} className="ml-auto shrink-0 text-slate-400" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-64 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-400">No options</div>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  onChange(o.id);
                  close();
                }}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  value === o.id
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-slate-50 dark:hover:bg-slate-800",
                )}
              >
                <span className={clsx("rounded px-1.5 py-0.5 text-[11px]", chipClass(o.color))}>
                  {o.label}
                </span>
                {value === o.id && <Check size={11} className="ml-auto text-indigo-600" />}
              </button>
            ))
          )}
        </div>
      )}
    </Menu>
  );
}

function SelectChipList({
  options,
  value,
  onChange,
}: {
  options: SelectOption[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }
  return (
    <Menu
      width={220}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-7 min-w-0 flex-1 items-center gap-1 rounded border px-2 text-xs",
            open
              ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
          )}
        >
          {value.length === 0 ? (
            <span className="truncate text-slate-400">Pick options</span>
          ) : (
            <span className="truncate text-slate-700 dark:text-slate-200">
              {value.length} selected
            </span>
          )}
          <ChevronDown size={11} className="ml-auto shrink-0 text-slate-400" />
        </button>
      )}
    >
      {() => (
        <div className="max-h-64 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-400">No options</div>
          ) : (
            options.map((o) => {
              const on = value.includes(o.id);
              return (
                <button
                  key={o.id}
                  onClick={() => toggle(o.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
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
                  <span className={clsx("rounded px-1.5 py-0.5 text-[11px]", chipClass(o.color))}>
                    {o.label}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </Menu>
  );
}

function LinkChipList({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }
  return (
    <Menu
      width={240}
      trigger={({ ref, onClick, open }) => (
        <button
          ref={ref}
          onClick={onClick}
          className={clsx(
            "flex h-7 min-w-0 flex-1 items-center gap-1 rounded border px-2 text-xs",
            open
              ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10"
              : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
          )}
        >
          {value.length === 0 ? (
            <span className="truncate text-slate-400">Pick records</span>
          ) : (
            <span className="truncate text-slate-700 dark:text-slate-200">
              {value.length} linked
            </span>
          )}
          <ChevronDown size={11} className="ml-auto shrink-0 text-slate-400" />
        </button>
      )}
    >
      {() => (
        <div className="max-h-64 overflow-y-auto">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-slate-400">
              No records to link to.
            </div>
          ) : (
            options.map((o) => {
              const on = value.includes(o.id);
              return (
                <button
                  key={o.id}
                  onClick={() => toggle(o.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
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
                  <span className="truncate text-slate-700 dark:text-slate-200">{o.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </Menu>
  );
}

// ───────────────────── sort popover ──────────────────────────────────────────

export function SortPopover({
  open,
  onClose,
  triggerRef,
  fields,
  sorts,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  fields: BaseField[];
  sorts: BaseSortRule[];
  onChange: (next: BaseSortRule[]) => void;
}) {
  function addSort() {
    const used = new Set(sorts.map((s) => s.fieldId));
    const next = fields.find((f) => !used.has(f.id)) ?? fields[0];
    if (!next) return;
    onChange([
      ...sorts,
      {
        id: Math.random().toString(36).slice(2, 10),
        fieldId: next.id,
        direction: "asc",
      },
    ]);
  }

  function update(id: string, patch: Partial<BaseSortRule>) {
    onChange(sorts.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function remove(id: string) {
    onChange(sorts.filter((s) => s.id !== id));
  }

  return (
    <ToolbarPopover open={open} onClose={onClose} triggerRef={triggerRef} width={420}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Sort
        </span>
        {sorts.length > 0 && (
          <button
            onClick={() => onChange([])}
            className="text-[11px] text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400"
          >
            Clear all
          </button>
        )}
      </div>
      {sorts.length === 0 ? (
        <p className="px-1 py-3 text-xs text-slate-500 dark:text-slate-400">
          No sort applied. Records appear in creation order.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sorts.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <FieldPicker
                fields={fields}
                value={s.fieldId}
                onChange={(fid) => update(s.id, { fieldId: fid })}
              />
              <DirectionToggle
                value={s.direction}
                onChange={(d) => update(s.id, { direction: d })}
              />
              <button
                onClick={() => remove(s.id)}
                className="ml-auto rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                aria-label="Remove sort"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={addSort}
        disabled={fields.length === 0}
        className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
      >
        <Plus size={11} /> Add sort
      </button>
    </ToolbarPopover>
  );
}

function DirectionToggle({
  value,
  onChange,
}: {
  value: "asc" | "desc";
  onChange: (d: "asc" | "desc") => void;
}) {
  return (
    <div className="flex h-7 overflow-hidden rounded border border-slate-200 dark:border-slate-700">
      <button
        onClick={() => onChange("asc")}
        className={clsx(
          "px-2 text-[11px]",
          value === "asc"
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800",
        )}
      >
        A → Z
      </button>
      <button
        onClick={() => onChange("desc")}
        className={clsx(
          "border-l border-slate-200 px-2 text-[11px] dark:border-slate-700",
          value === "desc"
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
            : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800",
        )}
      >
        Z → A
      </button>
    </div>
  );
}

// ───────────────────── hide-fields popover ──────────────────────────────────

export function HideFieldsPopover({
  open,
  onClose,
  triggerRef,
  fields,
  hiddenFieldIds,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  fields: BaseField[];
  hiddenFieldIds: string[];
  onChange: (next: string[]) => void;
}) {
  const hidden = new Set(hiddenFieldIds);
  function toggle(id: string) {
    if (hidden.has(id)) {
      onChange(hiddenFieldIds.filter((x) => x !== id));
    } else {
      onChange([...hiddenFieldIds, id]);
    }
  }
  return (
    <ToolbarPopover open={open} onClose={onClose} triggerRef={triggerRef} width={260}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Fields
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => onChange([])}
            className="text-[11px] text-slate-500 hover:text-indigo-600 dark:text-slate-400"
          >
            Show all
          </button>
          <button
            onClick={() =>
              onChange(fields.filter((f) => !f.isPrimary).map((f) => f.id))
            }
            className="text-[11px] text-slate-500 hover:text-indigo-600 dark:text-slate-400"
          >
            Hide all
          </button>
        </div>
      </div>
      <ul className="flex flex-col">
        {fields.map((f) => {
          const on = !hidden.has(f.id);
          const locked = f.isPrimary;
          return (
            <li key={f.id}>
              <button
                onClick={() => !locked && toggle(f.id)}
                disabled={locked}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  locked
                    ? "cursor-not-allowed text-slate-400"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
                )}
                title={locked ? "Primary field is always visible" : undefined}
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
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </ToolbarPopover>
  );
}

// ───────────────────── view tabs ────────────────────────────────────────────

export function ViewTabs({
  views,
  activeViewId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: {
  views: { id: string; name: string }[];
  activeViewId: string | null;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto px-3 py-1.5">
      {views.map((v) => {
        const active = v.id === activeViewId;
        return (
          <ViewTab
            key={v.id}
            label={v.name}
            active={active}
            onClick={() => onSwitch(v.id)}
            onRename={() => onRename(v.id)}
            onDelete={views.length > 1 ? () => onDelete(v.id) : undefined}
          />
        );
      })}
      <button
        onClick={onCreate}
        className="ml-1 flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11px] text-slate-500 hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/10"
      >
        <Plus size={11} /> Add view
      </button>
    </div>
  );
}

function ViewTab({
  label,
  active,
  onClick,
  onRename,
  onDelete,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onRename: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={clsx(
        "group relative flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
        active
          ? "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300"
          : "border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
      )}
    >
      <button
        onClick={onClick}
        onDoubleClick={onRename}
        className="max-w-[160px] truncate text-left font-medium"
        title="Double-click to rename"
      >
        {label}
      </button>
      <Menu
        width={150}
        align="right"
        trigger={({ ref, onClick: toggle, open }) => (
          <button
            ref={ref}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            className={clsx(
              "rounded p-0.5 hover:bg-slate-200/70 dark:hover:bg-slate-700",
              open || active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            aria-label="View actions"
          >
            <ChevronDown size={10} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              onClick={() => {
                close();
                onRename();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Rename
            </button>
            {onDelete && (
              <button
                onClick={() => {
                  close();
                  onDelete();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                Delete view
              </button>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

// Re-export icons so the toolbar in BaseDetail can keep its import block tight.
export { FilterIcon, ArrowUpDown, EyeOff };
