import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  Users,
  Video,
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
  Learning,
  LearningGrant,
  LearningGrantCandidate,
  LearningGrantsResponse,
  LearningSourceKind,
  NoteAccessLevel,
} from "../lib/api";
import { formatBodyLength } from "./LearningsIndex";

export default function LearningDetail({ company }: { company: Company }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const [row, setRow] = React.useState<Learning | null>(null);
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
      const r = await api.get<Learning>(
        `/api/companies/${company.id}/learnings/${slug}`,
      );
      setRow(r);
      setTitle(r.title);
      setSummary(r.summary);
      setTags(r.tags);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not load learning",
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
      const updated = await api.patch<Learning>(
        `/api/companies/${company.id}/learnings/${row.slug}`,
        { title: title.trim(), summary, tags },
      );
      setRow(updated);
      setEditing(false);
      toast("Saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function remove() {
    if (!row) return;
    const ok = await dialog.confirm({
      title: "Delete this learning?",
      message:
        "Both the extracted text and the original file (if any) are removed. AI employees lose access immediately.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/learnings/${row.slug}`);
      toast("Deleted", "success");
      navigate(`/c/${company.slug}/learnings`);
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
          Learning not found
        </h2>
        <Button
          variant="secondary"
          onClick={() => navigate(`/c/${company.slug}/learnings`)}
        >
          <ArrowLeft size={14} /> Back to learnings
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-4 dark:bg-slate-900 dark:border-slate-700">
        <Breadcrumbs
          items={[
            { label: "Learnings", to: `/c/${company.slug}/learnings` },
            { label: row.title },
          ]}
        />
        <div className="mt-3 flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <SourceKindIcon kind={row.sourceKind} />
          </div>
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-lg font-semibold"
              />
            ) : (
              <h1 className="truncate text-xl font-semibold text-slate-900 dark:text-slate-100">
                {row.title}
              </h1>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="capitalize">{row.sourceKind}</span>
              <span>·</span>
              <span>{formatBodyLength(row.bodyLength)}</span>
              <span>·</span>
              <span>{formatBytes(row.bytes)}</span>
              {row.status !== "ready" && (
                <>
                  <span>·</span>
                  <StatusBadge status={row.status} />
                </>
              )}
              {row.sourceUrl && (
                <>
                  <span>·</span>
                  <a
                    href={row.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    Open source <ExternalLink size={12} />
                  </a>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {row.storageKey && (
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    `/api/companies/${company.id}/learnings/${row.slug}/file`,
                    "_blank",
                  )
                }
              >
                <Download size={14} /> Original
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setShowShare(true)}
            >
              <Users size={14} /> Share
            </Button>
            {editing ? (
              <Button onClick={save}>
                <Save size={14} /> Save
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button variant="danger" onClick={remove}>
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {row.status === "failed" && row.errorMessage && (
            <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Ingestion failed</div>
                <div className="mt-0.5">{row.errorMessage}</div>
              </div>
            </div>
          )}

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Summary
            </h2>
            {editing ? (
              <Textarea
                className="mt-2"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
              />
            ) : (
              <p className="mt-2 whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">
                {row.summary || (
                  <span className="text-slate-400 dark:text-slate-500">
                    No summary.
                  </span>
                )}
              </p>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Tags
            </h2>
            {editing ? (
              <Input
                className="mt-2"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="comma, separated"
              />
            ) : row.tagList.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">
                No tags yet.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.tagList.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Extracted text
            </h2>
            {row.bodyText ? (
              <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 font-sans text-sm leading-6 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {row.bodyText}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">
                No extracted text on this row.
              </p>
            )}
          </section>
        </div>
      </div>

      <ShareModal
        open={showShare}
        company={company}
        learning={row}
        onClose={() => setShowShare(false)}
      />
    </div>
  );
}

function SourceKindIcon({ kind }: { kind: LearningSourceKind }) {
  const size = 22;
  if (kind === "url") return <Globe size={size} />;
  if (kind === "pdf") return <FileText size={size} />;
  if (kind === "epub") return <BookOpen size={size} />;
  if (kind === "video") return <Video size={size} />;
  return <Sparkles size={size} />;
}

function StatusBadge({ status }: { status: Learning["status"] }) {
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

// ---------------- Share modal ----------------

function ShareModal({
  open,
  company,
  learning,
  onClose,
}: {
  open: boolean;
  company: Company;
  learning: Learning;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<LearningGrant[]>([]);
  const [candidates, setCandidates] = React.useState<LearningGrantCandidate[]>(
    [],
  );
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!open) return;
    try {
      const [g, cs] = await Promise.all([
        api.get<LearningGrantsResponse>(
          `/api/companies/${company.id}/learnings/${learning.slug}/grants`,
        ),
        api.get<LearningGrantCandidate[]>(
          `/api/companies/${company.id}/learnings/${learning.slug}/grant-candidates`,
        ),
      ]);
      setGrants(g.direct);
      setCandidates(cs);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }, [open, company.id, learning.slug, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(employeeId: string, accessLevel: NoteAccessLevel) {
    setBusy(true);
    try {
      await api.post<LearningGrant>(
        `/api/companies/${company.id}/learnings/${learning.slug}/grants`,
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
        `/api/companies/${company.id}/learnings/${learning.slug}/grants/${grantId}`,
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
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Has access
          </h3>
          {grants.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No employees yet — pick from the list below to share this
              learning.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {grants.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {g.employee?.name ?? "Unknown"}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
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
                    Revoke
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
