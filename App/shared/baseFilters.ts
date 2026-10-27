/**
 * The filter and sort rules a Base view applies to its rows, evaluated in one
 * place. The grid runs them in the browser against the rows it already loaded;
 * a Chart over a Base runs the same rules on the server, so "Status is Won"
 * means the same thing in a view and on a dashboard.
 *
 * Only the slices of a field and a row the rules read are typed here, so the
 * client's hydrated rows and the server's both fit without conversion.
 */

export const BASE_FILTER_OPERATORS = [
  "is",
  "isNot",
  "contains",
  "doesNotContain",
  "isEmpty",
  "isNotEmpty",
  "equals",
  "notEquals",
  "greaterThan",
  "lessThan",
  "greaterThanOrEqual",
  "lessThanOrEqual",
  "isAnyOf",
  "isNoneOf",
  "hasAnyOf",
  "hasAllOf",
  "hasNoneOf",
  "isBefore",
  "isAfter",
  "isChecked",
  "isUnchecked",
] as const;

/**
 * Operators for a filter rule. A flat union so the UI can drive its operator
 * dropdown from a single source; which ones a field offers depends on its type.
 */
export type BaseFilterOperator = (typeof BASE_FILTER_OPERATORS)[number];

export type BaseFilterRule = {
  id: string;
  fieldId: string;
  operator: BaseFilterOperator;
  value?: unknown;
};

export type BaseSortRule = {
  id: string;
  fieldId: string;
  direction: "asc" | "desc";
};

export type BaseRuleField = { id: string; type: string };
export type BaseRuleRecord = { data: Record<string, unknown>; sortOrder: number };

export function isBaseCellEmpty(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === "string" && val === "") return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function asLowerString(v: unknown): string | null {
  return typeof v === "string" ? v.toLowerCase() : null;
}

export function baseRecordMatchesRule(
  record: BaseRuleRecord,
  rule: Pick<BaseFilterRule, "fieldId" | "operator" | "value">,
  field: BaseRuleField,
): boolean {
  const val = record.data[rule.fieldId];

  switch (rule.operator) {
    case "isEmpty":
      return isBaseCellEmpty(val);
    case "isNotEmpty":
      return !isBaseCellEmpty(val);
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
      if (isBaseCellEmpty(val)) return true;
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
      return (rule.value as unknown[]).every((v) => (val as unknown[]).includes(v));
    }
    case "hasNoneOf": {
      if (!Array.isArray(rule.value)) return true;
      if (!Array.isArray(val)) return true;
      return !(rule.value as unknown[]).some((v) => (val as unknown[]).includes(v));
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

/**
 * Keep the rows every rule matches (rules are joined with AND). A rule naming
 * a field the table no longer has is skipped, so a view survives a deleted
 * column; a Chart refuses such a rule before it gets here instead.
 */
export function applyBaseFilters<R extends BaseRuleRecord>(
  records: R[],
  filters: readonly Pick<BaseFilterRule, "fieldId" | "operator" | "value">[],
  fields: readonly BaseRuleField[],
): R[] {
  if (filters.length === 0) return records;
  const fieldById = new Map(fields.map((f) => [f.id, f] as const));
  return records.filter((r) =>
    filters.every((rule) => {
      const f = fieldById.get(rule.fieldId);
      if (!f) return true;
      return baseRecordMatchesRule(r, rule, f);
    }),
  );
}

/** Order two cell values of one field; empty cells sort after everything else. */
export function compareBaseValues(a: unknown, b: unknown, type: string): number {
  const aEmpty = isBaseCellEmpty(a);
  const bEmpty = isBaseCellEmpty(b);
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

export function applyBaseSorts<R extends BaseRuleRecord>(
  records: R[],
  sorts: readonly Pick<BaseSortRule, "fieldId" | "direction">[],
  fields: readonly BaseRuleField[],
): R[] {
  if (sorts.length === 0) return records;
  const fieldById = new Map(fields.map((f) => [f.id, f] as const));
  // Stable sort copy — slice first so callers' original array is preserved.
  return records.slice().sort((a, b) => {
    for (const s of sorts) {
      const f = fieldById.get(s.fieldId);
      if (!f) continue;
      const cmp = compareBaseValues(a.data[s.fieldId], b.data[s.fieldId], f.type);
      if (cmp !== 0) return s.direction === "asc" ? cmp : -cmp;
    }
    return a.sortOrder - b.sortOrder;
  });
}
