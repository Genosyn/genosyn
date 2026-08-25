import React from "react";
import { Select } from "@/components/ui/Select";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
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
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { FormError } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import {
  ChartRenderer,
  type QueryResult,
  type VizConfig,
  type VizType,
} from "../components/charts/ChartRenderer";
import { useExplore } from "./ExploreLayout";
import { AsyncResourceTagPicker } from "../components/TagPicker";
import { useLiveRefetch } from "../components/CompanySocket";
import { ExploreDashboardDetailsModal } from "../components/explore/ExploreDashboardDetailsModal";

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
  const dialog = useDialog();
  const { reload: reloadIndex } = useExplore();

  const [data, setData] = React.useState<DashboardDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [editingDetails, setEditingDetails] = React.useState(false);
  const [savingDetails, setSavingDetails] = React.useState(false);
  const [detailsError, setDetailsError] = React.useState<string | null>(null);
  const [addCardError, setAddCardError] = React.useState<string | null>(null);
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

  // Live-refresh only while NOT editing the layout, and silently — the full
  // `reload` flips a spinner and navigates away on a transient error, neither
  // of which should happen on a background broadcast.
  const liveReload = React.useCallback(async () => {
    if (editing) return;
    try {
      const d = await api.get<DashboardDetail>(
        `/api/companies/${company.id}/explore/dashboards/${slug}`,
      );
      setData(d);
    } catch {
      // Ignore transient errors on a live refresh; the next event reconciles.
    }
  }, [company.id, slug, editing]);
  useLiveRefetch("dashboard", liveReload);

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
          [chartSlug]: { kind: "error", message: errorMessage(err) },
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
      void dialog.error(err, { title: "Couldn’t delete the dashboard" });
    }
  }

  async function saveDashboardDetails(details: { title: string; description: string }) {
    if (!data) return;
    setDetailsError(null);
    setSavingDetails(true);
    try {
      await api.patch(`/api/companies/${company.id}/explore/dashboards/${data.slug}`, details);
      setEditingDetails(false);
      await reload();
      await reloadIndex();
    } catch (err) {
      setDetailsError(errorMessage(err));
    } finally {
      setSavingDetails(false);
    }
  }

  async function addCard(chartId: string) {
    if (!data) return;
    setAddCardError(null);
    try {
      await api.post(`/api/companies/${company.id}/explore/dashboards/${data.slug}/cards`, {
        chartId,
      });
      setPicking(false);
      await reload();
    } catch (err) {
      setAddCardError(errorMessage(err));
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
      void dialog.error(err, { title: "Couldn’t remove the card" });
    }
  }

  async function patchCard(card: CardDTO, patch: Partial<CardDTO>) {
    if (!data) return;
    setData((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((candidate) =>
              candidate.id === card.id ? { ...candidate, ...patch } : candidate,
            ),
          }
        : current,
    );
    try {
      await api.patch(
        `/api/companies/${company.id}/explore/dashboards/${data.slug}/cards/${card.id}`,
        patch,
      );
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update the card" });
      await reload();
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
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-700 dark:bg-slate-950">
        <Link
          to={`/c/${company.slug}/explore`}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <ChevronLeft size={16} />
        </Link>
        <div className="min-w-[180px] flex-1">
          <button
            onClick={() => setEditingDetails(true)}
            className="block max-w-full truncate text-left text-base font-semibold text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-300"
            title="Rename dashboard"
          >
            {data.title}
          </button>
          {data.description && (
            <p className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
              {data.description}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Re-run every card; clears stale state and refetches.
            for (const c of data.charts) void runChart(c.slug);
          }}
        >
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

      <div className="border-b border-slate-200 bg-white px-6 py-2 dark:border-slate-700 dark:bg-slate-950">
        <AsyncResourceTagPicker
          companyId={company.id}
          resourceType="dashboard"
          resourceId={data.id}
        />
      </div>

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
          <div className="explore-dashboard-grid">
            {data.cards.map((card) => {
              const chart = chartById.get(card.chartId);
              if (!chart) return null;
              const run = runs[chart.slug] ?? { kind: "idle" as const };
              const label = card.titleOverride || chart.title;
              return (
                <div
                  key={card.id}
                  className="explore-dashboard-card flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950"
                  style={
                    {
                      "--explore-card-column": `${card.x + 1} / span ${card.w}`,
                      "--explore-card-row": `${card.y + 1} / span ${card.h}`,
                    } as React.CSSProperties
                  }
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                    {editing ? (
                      <>
                        <CardTitleEditor
                          card={card}
                          chartTitle={chart.title}
                          onChange={(titleOverride) => patchCard(card, { titleOverride })}
                        />
                        <CardEditControls
                          card={card}
                          onChange={(patch) => patchCard(card, patch)}
                          onDelete={() => deleteCard(card)}
                        />
                      </>
                    ) : (
                      <>
                        <Link
                          to={`/c/${company.slug}/explore/charts/${chart.slug}`}
                          className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 hover:text-indigo-600 dark:text-slate-200 dark:hover:text-indigo-300"
                          title={chart.title}
                        >
                          {label}
                        </Link>
                        <button
                          onClick={() => runChart(chart.slug)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          title="Refresh chart"
                          aria-label={`Refresh ${label}`}
                        >
                          <RefreshCw size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="relative min-h-0 flex-1">
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
          companySlug={company.slug}
          alreadyOn={new Set(data.cards.map((c) => c.chartId))}
          error={addCardError}
          onClose={() => {
            setPicking(false);
            setAddCardError(null);
          }}
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
      <ExploreDashboardDetailsModal
        open={editingDetails}
        title={data.title}
        description={data.description}
        submitLabel="Save details"
        saving={savingDetails}
        error={detailsError}
        onClose={() => {
          setEditingDetails(false);
          setDetailsError(null);
        }}
        onSubmit={(details) => void saveDashboardDetails(details)}
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
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => onChange({ x: card.x - 1 })}
        disabled={card.x <= 0}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Move left"
        aria-label="Move card left"
      >
        <ArrowLeft size={11} />
      </button>
      <button
        onClick={() => onChange({ x: card.x + 1 })}
        disabled={card.x + card.w >= 12}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Move right"
        aria-label="Move card right"
      >
        <ArrowRight size={11} />
      </button>
      <button
        onClick={() => onChange({ y: card.y - 1 })}
        disabled={card.y <= 0}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Move up"
        aria-label="Move card up"
      >
        <ArrowUp size={11} />
      </button>
      <button
        onClick={() => onChange({ y: card.y + 1 })}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Move down"
        aria-label="Move card down"
      >
        <ArrowDown size={11} />
      </button>
      <Select
        value={card.w}
        onChange={(e) => {
          const width = Number(e.target.value);
          onChange({ w: width, x: Math.min(card.x, 12 - width) });
        }}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900"
        title="Card width"
        aria-label="Card width"
      >
        <option value={3}>Narrow</option>
        <option value={4}>Small</option>
        <option value={6}>Half</option>
        <option value={8}>Wide</option>
        <option value={9}>Large</option>
        <option value={12}>Full</option>
      </Select>
      <Select
        value={card.h}
        onChange={(e) => onChange({ h: Number(e.target.value) })}
        className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900"
        title="Card height"
        aria-label="Card height"
      >
        <option value={2}>Short</option>
        <option value={3}>Compact</option>
        <option value={4}>Medium</option>
        <option value={5}>Roomy</option>
        <option value={6}>Tall</option>
        <option value={8}>Extra tall</option>
      </Select>
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

function CardTitleEditor({
  card,
  chartTitle,
  onChange,
}: {
  card: CardDTO;
  chartTitle: string;
  onChange: (titleOverride: string) => void;
}) {
  const [value, setValue] = React.useState(card.titleOverride);

  React.useEffect(() => {
    setValue(card.titleOverride);
  }, [card.titleOverride]);

  function commit() {
    const next = value.trim();
    if (next !== card.titleOverride) onChange(next);
  }

  return (
    <input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
      placeholder={chartTitle}
      aria-label="Dashboard card title"
      title="Override this card title"
      className="min-w-32 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-medium text-slate-700 placeholder:text-slate-400 hover:border-slate-200 focus:border-indigo-400 focus:outline-none dark:text-slate-200 dark:hover:border-slate-700"
    />
  );
}

function ChartPicker({
  companyId,
  companySlug,
  alreadyOn,
  error,
  onClose,
  onPick,
}: {
  companyId: string;
  companySlug: string;
  alreadyOn: Set<string>;
  error: string | null;
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
        <FormError message={error} />
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700">
          {charts === null ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              <span>{q ? "No charts match that search." : "No charts yet."}</span>
              {!q && (
                <Link to={`/c/${companySlug}/explore/charts/new`} onClick={onClose}>
                  <Button size="sm">Create a chart</Button>
                </Link>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((c) => {
                const isOn = alreadyOn.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => {
                        if (!isOn) onPick(c.id);
                      }}
                      disabled={isOn}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60 dark:hover:bg-slate-800 dark:disabled:bg-slate-900"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-900 dark:text-slate-100">{c.title}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {c.vizType}
                        </div>
                      </div>
                      {isOn && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          already added
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
