import React from "react";
import { Check, Plus, Tag, X } from "lucide-react";
import { api, CompanyTag, TaggableResourceType } from "../lib/api";
import { Spinner } from "./ui/Spinner";
import { useToast } from "./ui/Toast";

export function TagChips({ tags, limit }: { tags: CompanyTag[]; limit?: number }) {
  const shown = limit ? tags.slice(0, limit) : tags;
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <span
          key={tag.id}
          className="max-w-40 truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          title={tag.name}
        >
          {tag.name}
        </span>
      ))}
      {limit && tags.length > limit && (
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          +{tags.length - limit}
        </span>
      )}
    </span>
  );
}

export function TagFilterBar({
  tags,
  selectedId,
  onSelect,
}: {
  tags: CompanyTag[];
  selectedId: string | null;
  onSelect: (tagId: string | null) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-slate-500">
        <Tag size={12} /> Tags
      </span>
      {tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          onClick={() => onSelect(selectedId === tag.id ? null : tag.id)}
          className={
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition " +
            (selectedId === tag.id
              ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-slate-600")
          }
        >
          {tag.name}
        </button>
      ))}
    </div>
  );
}

/** Multi-select company tags, with inline creation for names that do not exist yet. */
export function TagPicker({
  companyId,
  value,
  onChange,
  label = "Tags",
}: {
  companyId: string;
  value: CompanyTag[];
  onChange: (tags: CompanyTag[]) => void | Promise<void>;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [available, setAvailable] = React.useState<CompanyTag[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const load = React.useCallback(async () => {
    try {
      setAvailable(await api.get<CompanyTag[]>(`/api/companies/${companyId}/tags`));
    } catch (err) {
      toast((err as Error).message, "error");
      setAvailable([]);
    }
  }, [companyId, toast]);

  React.useEffect(() => {
    if (open && available === null) load();
  }, [open, available, load]);

  React.useEffect(() => {
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function commit(next: CompanyTag[]) {
    if (saving) return;
    setSaving(true);
    try {
      await onChange(next);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function createTag() {
    const name = query.trim().replace(/\s+/g, " ");
    if (!name || saving) return;
    setSaving(true);
    try {
      const created = await api.post<CompanyTag>(`/api/companies/${companyId}/tags`, { name });
      setAvailable((current) => {
        const rows = current ?? [];
        return rows.some((tag) => tag.id === created.id)
          ? rows
          : [...rows, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      if (!value.some((tag) => tag.id === created.id)) {
        await onChange([...value, created]);
      }
      setQuery("");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  const q = query.trim().toLocaleLowerCase();
  const filtered = (available ?? []).filter((tag) => tag.name.toLocaleLowerCase().includes(q));
  const exact = (available ?? []).some(
    (tag) => tag.normalizedName === query.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
  );

  return (
    <div ref={rootRef} className="relative">
      <div className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{label}</div>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
        {value.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex max-w-48 items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <span className="truncate">{tag.name}</span>
            <button
              type="button"
              onClick={() => commit(value.filter((row) => row.id !== tag.id))}
              disabled={saving}
              className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
              aria-label={`Remove ${tag.name}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          disabled={saving || value.length >= 20}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-indigo-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-indigo-300"
        >
          {saving ? <Spinner size={12} /> : <Plus size={12} />}
          Add tag
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-full min-w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-slate-100 p-2 dark:border-slate-800">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && query.trim() && !exact) {
                  event.preventDefault();
                  createTag();
                }
              }}
              placeholder="Find or create a tag…"
              autoFocus
              maxLength={50}
              className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900/30"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {available === null ? (
              <div className="flex justify-center p-4">
                <Spinner size={15} />
              </div>
            ) : (
              <>
                {filtered.map((tag) => {
                  const selected = value.some((row) => row.id === tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() =>
                        commit(
                          selected ? value.filter((row) => row.id !== tag.id) : [...value, tag],
                        )
                      }
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded border border-slate-300 dark:border-slate-600">
                        {selected && <Check size={11} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                    </button>
                  );
                })}
                {query.trim() && !exact && (
                  <button
                    type="button"
                    onClick={createTag}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
                  >
                    <Plus size={14} /> Create &quot;{query.trim()}&quot;
                  </button>
                )}
                {!query.trim() && filtered.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500">
                    Type a name to create the company&apos;s first tag.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ResourceTagPicker({
  companyId,
  resourceType,
  resourceId,
  value,
  onSaved,
  label,
}: {
  companyId: string;
  resourceType: TaggableResourceType;
  resourceId: string;
  value: CompanyTag[];
  onSaved: (tags: CompanyTag[]) => void | Promise<void>;
  label?: string;
}) {
  return (
    <TagPicker
      companyId={companyId}
      value={value}
      label={label}
      onChange={async (tags) => {
        const saved = await api.put<CompanyTag[]>(
          `/api/companies/${companyId}/tags/resources/${resourceType}/${resourceId}`,
          { tagIds: tags.map((tag) => tag.id) },
        );
        await onSaved(saved);
      }}
    />
  );
}

/** Fetching wrapper for resource pages whose primary DTO does not embed tags. */
export function AsyncResourceTagPicker({
  companyId,
  resourceType,
  resourceId,
  label,
}: {
  companyId: string;
  resourceType: TaggableResourceType;
  resourceId: string;
  label?: string;
}) {
  const [tags, setTags] = React.useState<CompanyTag[] | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setTags(null);
    api
      .get<CompanyTag[]>(`/api/companies/${companyId}/tags/resources/${resourceType}/${resourceId}`)
      .then(setTags)
      .catch((err) => {
        toast((err as Error).message, "error");
        setTags([]);
      });
  }, [companyId, resourceId, resourceType, toast]);

  if (tags === null) {
    return (
      <div className="h-9 rounded-lg bg-slate-100 dark:bg-slate-800" aria-label="Loading tags" />
    );
  }
  return (
    <ResourceTagPicker
      companyId={companyId}
      resourceType={resourceType}
      resourceId={resourceId}
      value={tags}
      onSaved={setTags}
      label={label}
    />
  );
}
