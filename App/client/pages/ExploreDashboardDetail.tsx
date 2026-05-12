import React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Check,
  ChevronLeft,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { ExploreShareModal } from "./ExploreShareModal";
import { api, Company } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { useDialog } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import {
  ChartRenderer,
  type QueryResult,
  type VizConfig,
  type VizType,
} from "../components/charts/ChartRenderer";
import { useExplore } from "./ExploreLayout";

/**
 * Dashboard detail. Renders the saved cards in a 12-column CSS grid and
 * runs each card's bound chart on mount + on demand. An "Edit" toggle
 * switches the grid into reposition / resize / remove mode; "Done"
 * exits. Adds a card via the "+" button, which opens a chart picker.
 */

type ChartDTO = {
  id: string;
  slug: string;
  title: string;
  description: string;
  connectionId: string;
  sql: string;
  vizType: VizType;
  vizConfig: VizConfig;
  updatedAt: string;
};

type CardDTO = {
  id: string;
  dashboardId: string;
  chartId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  titleOverride: string;
};

type DashboardDetail = {
  id: string;
  slug: string;
  title: string;
  description: string;
  cards: CardDTO[];
  charts: ChartDTO[];
};

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; result: QueryResult }
  | { kind: "error"; message: string };

export default function ExploreDashboardDetail({ company }: { company: Company }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const dialog = useDialog();
  const { reload: reloadIndex } = useExplore();

  const [data, setData] = React.useState<DashboardDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [runs, setRuns] = React.useState<Record<string, RunState>>({});

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<DashboardDetail>(
        `/api/companies/${company.id}/explore/dashboards/${slug}`,
      );
      setData(d);
    } catch {
      navigate(`/c/${company.slug}/explore`, { replace: true });
    } finally {
      setLoading(false);
    }
  }, [company.id, company.slug, slug, navigate]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const runChart = React.useCallback(
    async (chartSlug: string) => {
      setRuns((r) => ({ ...r, [chartSlug]: { kind: "running" } }));
      try {
        const result = await api.post<QueryResult>(
          `/api/companies/${company.id}/explore/charts/${chartSlug}/run`,
          {},
        );
        setRuns((r) => ({ ...r, [chartSlug]: { kind: "ok", result } }));
      } catch (err) {
        setRuns((r) => ({
          ...r,
          [chartSlug]: { kind: "error", message: (err as Error).message },
        }));
      }
    },
    [company.id],
  );

  // Run every card's chart once the dashboard loads.
  React.useEffect(() => {
    if (!data) return;
    const seen = new Set<string>();
    for (const card of data.cards) {
      const chart = data.charts.find((c) => c.id === card.chartId);
      if (!chart || seen.has(chart.slug)) continue;
      seen.add(chart.slug);
      if (!runs[chart.slug]) void runChart(chart.slug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  async function destroy() {
    if (!data) return;
    const ok = await dialog.confirm({
      title: `Delete "${data.title}"?`,
      message: "All cards on this dashboard will be removed. Charts are kept.",
      variant: "danger",
      confirmLabel: "Delete dashboard",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/explore/dashboards/${data.slug}`);
      await reloadIndex();
      navigate(`/c/${company.slug}/explore`, { replace: true });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function renameDashboard() {
    if (!data) return;
    const title = await dialog.prompt({
      title: "Rename dashboard",
      defaultValue: data.title,
      confirmLabel: "Rename",
    });
    if (!title || title === data.title) return;
    try {
      await api.patch(
        `/api/companies/${company.id}/explore/dashboards/${data.slug}`,
        { title },
      );
      await reload();
      await reloadIndex();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function addCard(chartId: string) {
    if (!data) return;
    try {
      await api.post(
        `/api/companies/${company.id}/explore/dashboards/${data.slug}/cards`,
        { chartId },
      );
      setPicking(false);
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteCard(card: CardDTO) {
    if (!data) return;
    try {
      await api.del(
        `/api/companies/${company.id}/explore/dashboards/${data.slug}/cards/${card.id}`,
      );
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function patchCard(card: CardDTO, patch: Partial<CardDTO>) {
    if (!data) return;
    try {
      await api.patch(
        `/api/companies/${company.id}/explore/dashboards/${data.slug}/cards/${card.id}`,
        patch,
      );
      // Optimistic — update local state immediately, then refetch to settle.
      setData((d) =>
        d
          ? {
              ...d,
              cards: d.cards.map((c) =>
                c.id === card.id ? { ...c, ...patch } : c,
              ),
            }
          : d,
      );
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loading || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const chartById = new Map(data.charts.map((c) => [c.id, c]));

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 dark:bg-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-700 dark:bg-slate-950">
        <Link
          to={`/c/${company.slug}/explore`}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <ChevronLeft size={16} />
        </Link>
        <button
          onClick={renameDashboard}
          className="min-w-0 flex-1 truncate text-left text-base font-semibold text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-300"
          title="Rename"
        >
          {data.title}
        </button>
        <Button variant="ghost" size="sm" onClick={() => {
          // Re-run every card; clears stale state and refetches.
          for (const c of data.charts) void runChart(c.slug);
        }}>
          <RefreshCw size={14} /> Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setSharing(true)}>
          <Share2 size={14} /> Share
        </Button>
        <Button
          variant={editing ? "primary" : "secondary"}
          size="sm"
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? (
            <>
              <Check size={14} /> Done
            </>
          ) : (
            <>
              <Pencil size={14} /> Edit
            </>
          )}
        </Button>
        {editing && (
          <Button variant="ghost" size="sm" onClick={destroy}>
            <Trash2 size={14} className="text-red-500" />
          </Button>
        )}
        {editing && (
          <Button size="sm" onClick={() => setPicking(true)}>
            <Plus size={14} /> Add chart
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {data.cards.length === 0 ? (
          <EmptyState
            title="No cards yet"
            description="Pin a saved Chart to start filling this dashboard."
            action={
              <Button size="sm" onClick={() => setPicking(true)}>
                <Plus size={14} /> Add chart
              </Button>
            }
          />
        ) : (
          <div
            className="grid auto-rows-[64px] gap-4"
            style={{
              gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
            }}
          >
            {data.cards.map((card) => {
              const chart = chartById.get(card.chartId);
              if (!chart) return null;
              const run = runs[chart.slug] ?? { kind: "idle" as const };
              const label = card.titleOverride || chart.title;
              return (
                <div
                  key={card.id}
                  className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950"
                  style={{
                    gridColumn: `${card.x + 1} / span ${card.w}`,
                    gridRow: `${card.y + 1} / span ${card.h}`,
                  }}
                >
                  <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                    <Link
                      to={`/c/${company.slug}/explore/charts/${chart.slug}`}
                      className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-300"
                      title={chart.title}
                    >
                      {label}
                    </Link>
                    {editing ? (
                      <CardEditControls card={card} onChange={(p) => patchCard(card, p)} onDelete={() => deleteCard(card)} />
                    ) : (
                      <button
                        onClick={() => runChart(chart.slug)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        title="Refresh"
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
                  </div>
                  <div className="relative h-[calc(100%-37px)]">
                    {run.kind === "running" && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 dark:bg-slate-950/60">
                        <Spinner size={16} />
                      </div>
                    )}
                    {run.kind === "error" && (
                      <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-red-600 dark:text-red-400">
                        {run.message}
                      </div>
                    )}
                    {run.kind === "ok" && (
                      <div className="h-full p-2">
                        <ChartRenderer
                          vizType={chart.vizType}
                          vizConfig={chart.vizConfig}
                          result={run.result}
                        />
                      </div>
                    )}
                    {run.kind === "idle" && (
                      <div className="flex h-full items-center justify-center text-[11px] text-slate-400 dark:text-slate-500">
                        Pending…
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {picking && (
        <ChartPicker
          companyId={company.id}
          alreadyOn={new Set(data.cards.map((c) => c.chartId))}
          onClose={() => setPicking(false)}
          onPick={(chartId) => addCard(chartId)}
        />
      )}

      <ExploreShareModal
        open={sharing}
        onClose={() => setSharing(false)}
        companyId={company.id}
        kind="dashboard"
        slug={data.slug}
        rowTitle={data.title}
      />
    </div>
  );
}

function CardEditControls({
  card,
  onChange,
  onDelete,
}: {
  card: CardDTO;
  onChange: (patch: Partial<CardDTO>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <select
        value={card.w}
        onChange={(e) => onChange({ w: Number(e.target.value) })}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900"
        title="Width (cols)"
      >
        {[3, 4, 6, 8, 9, 12].map((n) => (
          <option key={n} value={n}>w{n}</option>
        ))}
      </select>
      <select
        value={card.h}
        onChange={(e) => onChange({ h: Number(e.target.value) })}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900"
        title="Height (rows)"
      >
        {[2, 3, 4, 5, 6, 8].map((n) => (
          <option key={n} value={n}>h{n}</option>
        ))}
      </select>
      <button
        onClick={onDelete}
        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
        title="Remove from dashboard"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ChartPicker({
  companyId,
  alreadyOn,
  onClose,
  onPick,
}: {
  companyId: string;
  alreadyOn: Set<string>;
  onClose: () => void;
  onPick: (chartId: string) => void;
}) {
  const [charts, setCharts] = React.useState<ChartDTO[] | null>(null);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    api
      .get<ChartDTO[]>(`/api/companies/${companyId}/explore/charts`)
      .then(setCharts)
      .catch(() => setCharts([]));
  }, [companyId]);

  const filtered = (charts ?? []).filter((c) =>
    c.title.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <Modal open onClose={onClose} title="Add a chart">
      <div className="flex flex-col gap-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter charts…"
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        />
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700">
          {charts === null ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              No charts. Create one first from Explore.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((c) => {
                const isOn = alreadyOn.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => onPick(c.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-900 dark:text-slate-100">
                          {c.title}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {c.vizType}
                        </div>
                      </div>
                      {isOn && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          already on board
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
