import React from "react";
import { Check, X } from "lucide-react";
import { api } from "../lib/api";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { Avatar } from "../components/ui/Avatar";

/**
 * Share modal for an Explore Chart or Dashboard. Identical shape — pass
 * `kind` to choose the endpoint family. Two access levels:
 *
 *   - read   → AI employee can list / get / run the chart (or view the dashboard)
 *   - write  → AI employee can also edit / delete the chart (or add cards
 *              to / rename / delete the dashboard)
 *
 * Humans bypass these grants entirely; the modal only governs what AI
 * employees can do through the MCP surface. Defaults: every employee
 * starts at `read` on a freshly-created row (auto-seeded server-side),
 * and the AI author of a row gets `write`.
 */

export type GrantKind = "chart" | "dashboard";
export type AccessLevel = "read" | "write";

type EmployeeRef = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

type Grant = {
  id: string;
  employeeId: string;
  accessLevel: AccessLevel;
  employee: EmployeeRef | null;
};

type GrantsResponse = { direct: Grant[] };

type Candidate = EmployeeRef & { alreadyGranted: boolean };

export function ExploreShareModal({
  open,
  onClose,
  onChanged,
  companyId,
  kind,
  slug,
  rowTitle,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
  companyId: string;
  kind: GrantKind;
  slug: string;
  rowTitle: string;
}) {
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<Grant[]>([]);
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const base = `/api/companies/${companyId}/explore/${kind === "chart" ? "charts" : "dashboards"}/${slug}`;

  const reload = React.useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const [g, cs] = await Promise.all([
        api.get<GrantsResponse>(`${base}/grants`),
        api.get<Candidate[]>(`${base}/grant-candidates`),
      ]);
      setGrants(g.direct);
      setCandidates(cs);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setLoading(false);
    }
  }, [open, base, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function add(employeeId: string, accessLevel: AccessLevel) {
    setBusy(true);
    try {
      await api.post<Grant>(`${base}/grants`, { employeeId, accessLevel });
      await reload();
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function changeLevel(grant: Grant, next: AccessLevel) {
    if (grant.accessLevel === next) return;
    setBusy(true);
    try {
      await api.patch(`${base}/grants/${grant.id}`, { accessLevel: next });
      await reload();
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(grantId: string) {
    setBusy(true);
    try {
      await api.del(`${base}/grants/${grantId}`);
      await reload();
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const ungranted = candidates.filter((c) => !c.alreadyGranted);
  const noun = kind === "chart" ? "chart" : "dashboard";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Share "${rowTitle}"`}
      size="lg"
    >
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Pick what each AI employee can do with this {noun} through its MCP
          tools — <span className="font-medium">View only</span> lets the
          employee list/run it, <span className="font-medium">Can edit</span>{" "}
          also lets them change or remove it.
          {kind === "dashboard" && (
            <>
              {" "}Granting a dashboard does <em>not</em> grant the underlying
              charts — share each chart separately if you want the data
              visible too.
            </>
          )}
        </p>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Has access
          </h3>
          {loading ? (
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              Loading…
            </p>
          ) : grants.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No AI employees have access. Add one below.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {grants.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar
                      name={g.employee?.name ?? "?"}
                      size="sm"
                    />
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
                        {g.employee?.role ?? ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <LevelSelect
                      value={g.accessLevel}
                      busy={busy}
                      onChange={(next) => changeLevel(g, next)}
                    />
                    <button
                      type="button"
                      onClick={() => remove(g.id)}
                      disabled={busy}
                      title="Revoke access"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </div>
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
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={c.name} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {c.name}
                      </div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {c.role}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => add(c.id, "read")}
                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      View only
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => add(c.id, "write")}
                      className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700 disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                    >
                      Can edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LevelSelect({
  value,
  busy,
  onChange,
}: {
  value: AccessLevel;
  busy: boolean;
  onChange: (next: AccessLevel) => void;
}) {
  return (
    <select
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value as AccessLevel)}
      className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      <option value="read">View only</option>
      <option value="write">Can edit</option>
    </select>
  );
}
