import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Pencil,
  Save,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import {
  api,
  Company,
  Resource,
  ResourceGrant,
  ResourceGrantCandidate,
  ResourceGrantsResponse,
  NoteAccessLevel,
} from "../lib/api";
import { SourceKindIcon, formatBodyLength } from "./ResourcesIndex";

export default function ResourceDetail({ company }: { company: Company }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [row, setRow] = React.useState<Resource | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [showShare, setShowShare] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [summary, setSummary] = React.useState("");
  const [tags, setTags] = React.useState("");

  const reload = React.useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const r = await api.get<Resource>(
        `/api/companies/${company.id}/resources/${slug}`,
      );
      setRow(r);
      setTitle(r.title);
      setSummary(r.summary);
      setTags(r.tags);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load resource",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [company.id, slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function save() {
    if (!row) return;
    try {
      const updated = await api.patch<Resource>(
        `/api/companies/${company.id}/resources/${row.slug}`,
        { title: title.trim(), summary, tags },
      );
      setRow(updated);
      setEditing(false);
      toast("Saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function cancelEdit() {
    if (!row) return;
    setTitle(row.title);
    setSummary(row.summary);
    setTags(row.tags);
    setEditing(false);
  }

  async function remove() {
    if (!row) return;
    const ok = await dialog.confirm({
      title: "Delete this resource?",
      message:
        "Both the extracted text and the original file (if any) are removed. AI employees lose access immediately.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/resources/${row.slug}`);
      toast("Deleted", "success");
      navigate(`/c/${company.slug}/resources`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if (!row) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Resource not found
        </h2>
        <Button
          variant="secondary"
          onClick={() => navigate(`/c/${company.slug}/resources`)}
        >
          <ArrowLeft size={14} /> Back to resources
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/85 px-6 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Resources", to: `/c/${company.slug}/resources` },
            { label: row.title },
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-10 pt-12 pb-16">
          <div className="mb-6 flex items-start gap-4">
            <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <SourceKindIcon kind={row.sourceKind} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <span className="capitalize">{row.sourceKind}</span> resource
              </div>
              {editing ? (
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="text-2xl font-bold"
                />
              ) : (
                <h1 className="break-words text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {row.title}
                </h1>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span>{formatBodyLength(row.bodyLength)}</span>
                <span aria-hidden>·</span>
                <span>{formatBytes(row.bytes)}</span>
                {row.status !== "ready" && (
                  <>
                    <span aria-hidden>·</span>
                    <StatusBadge status={row.status} />
                  </>
                )}
                {row.sourceUrl && (
                  <>
                    <span aria-hidden>·</span>
                    <a
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      <span className="max-w-[14rem] truncate">
                        {hostnameOf(row.sourceUrl)}
                      </span>
                      <ExternalLink size={11} />
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mb-8 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button onClick={save}>
                  <Save size={14} /> Save
                </Button>
                <Button variant="secondary" onClick={cancelEdit}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil size={14} /> Edit
                </Button>
                <Button variant="secondary" onClick={() => setShowShare(true)}>
                  <Users size={14} /> Share
                </Button>
                {row.storageKey && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      window.open(
                        `/api/companies/${company.id}/resources/${row.slug}/file`,
                        "_blank",
                      )
                    }
                  >
                    <Download size={14} /> Original
                  </Button>
                )}
                <div className="flex-1" />
                <Button variant="ghost" onClick={remove}>
                  <Trash2 size={14} />
                </Button>
              </>
            )}
          </div>

          {row.status === "failed" && row.errorMessage && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Ingestion failed</div>
                <div className="mt-0.5">{row.errorMessage}</div>
              </div>
            </div>
          )}

          <section className="mb-8">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Summary
            </h2>
            {editing ? (
              <Textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                placeholder="A short summary AI employees see alongside the title."
              />
            ) : row.summary ? (
              <p className="whitespace-pre-line text-base leading-7 text-slate-700 dark:text-slate-200">
                {row.summary}
              </p>
            ) : (
              <p className="text-sm italic text-slate-400 dark:text-slate-500">
                No summary yet.
              </p>
            )}
          </section>

          <section className="mb-10">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <Tag size={11} /> Tags
            </h2>
            {editing ? (
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="pricing, b2b, growth"
              />
            ) : row.tagList.length === 0 ? (
              <p className="text-sm italic text-slate-400 dark:text-slate-500">
                No tags yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {row.tagList.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Extracted text
            </h2>
            {row.bodyText ? (
              <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap p-5 font-sans text-sm leading-7 text-slate-800 dark:text-slate-200">
                  {row.bodyText}
                </pre>
              </div>
            ) : (
              <p className="text-sm italic text-slate-400 dark:text-slate-500">
                No extracted text on this row.
              </p>
            )}
          </section>
        </div>
      </div>

      <ShareModal
        open={showShare}
        company={company}
        resource={row}
        onClose={() => setShowShare(false)}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: Resource["status"] }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
        <AlertCircle size={12} /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
      <Loader2 size={12} className="animate-spin" /> {status}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ───────────────────────────── Share modal ──────────────────────────────

function ShareModal({
  open,
  company,
  resource,
  onClose,
}: {
  open: boolean;
  company: Company;
  resource: Resource;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<ResourceGrant[]>([]);
  const [candidates, setCandidates] = React.useState<ResourceGrantCandidate[]>(
    [],
  );
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!open) return;
    try {
      const [g, cs] = await Promise.all([
        api.get<ResourceGrantsResponse>(
          `/api/companies/${company.id}/resources/${resource.slug}/grants`,
        ),
        api.get<ResourceGrantCandidate[]>(
          `/api/companies/${company.id}/resources/${resource.slug}/grant-candidates`,
        ),
      ]);
      setGrants(g.direct);
      setCandidates(cs);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [open, company.id, resource.slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(employeeId: string, accessLevel: NoteAccessLevel) {
    setBusy(true);
    try {
      await api.post<ResourceGrant>(
        `/api/companies/${company.id}/resources/${resource.slug}/grants`,
        { employeeId, accessLevel },
      );
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(grantId: string) {
    setBusy(true);
    try {
      await api.del(
        `/api/companies/${company.id}/resources/${resource.slug}/grants/${grantId}`,
      );
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const ungranted = candidates.filter((c) => !c.alreadyGranted);

  return (
    <Modal open={open} onClose={onClose} title="Share with AI employees" size="lg">
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Every AI employee gets read access on ingest. Revoke individuals
          here, or grant access to anyone who joined the company after this
          resource was added.
        </p>
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Has access
          </h3>
          {grants.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No employees have access. Add one below.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {grants.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Check
                        size={12}
                        className="text-emerald-600 dark:text-emerald-400"
                      />
                      <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {g.employee?.name ?? "Unknown"}
                      </span>
                    </div>
                    <div className="ml-[18px] truncate text-xs text-slate-500 dark:text-slate-400">
                      {g.employee?.role ?? ""} ·{" "}
                      <span className="capitalize">{g.accessLevel}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(g.id)}
                    disabled={busy}
                  >
                    <X size={12} /> Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Add an employee
          </h3>
          {ungranted.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Every AI employee in this company already has access.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {ungranted.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {c.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {c.role}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => add(c.id, "read")}
                    disabled={busy}
                  >
                    Grant read
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
