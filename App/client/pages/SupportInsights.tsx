import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { BarChart3, Lightbulb, RefreshCw, Sparkles } from "lucide-react";

import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Table, TableCard, TD, TH, THead, TR } from "@/components/ui/Table";
import { errorMessage } from "@/lib/errors";
import {
  agoText,
  durationText,
  supportApi,
  type SupportAnalytics,
  type SupportSettings,
} from "@/lib/support";
import type { SupportOutletContext } from "./SupportLayout";

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </Card>
  );
}

/** Tickets per day: created as bars, solved as a marker on each. */
function VolumeChart({ volume }: { volume: SupportAnalytics["volume"] }) {
  const max = Math.max(1, ...volume.map((day) => Math.max(day.created, day.solved)));
  return (
    <figure>
      <div
        className="flex h-32 items-end gap-px"
        role="img"
        aria-label="Tickets created and solved per day"
      >
        {volume.map((day) => (
          <div
            key={day.date}
            className="relative flex h-full min-w-0 flex-1 items-end"
            title={`${day.date}: ${day.created} created, ${day.solved} solved`}
          >
            <div
              className="w-full rounded-t-sm bg-indigo-500/80 dark:bg-indigo-400/80"
              style={{ height: `${(day.created / max) * 100}%` }}
            />
            {day.solved > 0 && (
              <div
                className="absolute inset-x-0 h-0.5 bg-emerald-500"
                style={{ bottom: `${(day.solved / max) * 100}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-indigo-500/80" /> Created
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-3 bg-emerald-500" /> Solved
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * How Support is going. Every figure is counted by the server; the reading at the
 * top is an AI Employee's words about tickets the server counted. The table is
 * what tells owners where to let the AI go further: how each topic's drafts fare.
 */
export default function SupportInsights() {
  const { company } = useOutletContext<SupportOutletContext>();
  const dialog = useDialog();
  const api = React.useMemo(() => supportApi(company.id), [company.id]);
  const [days, setDays] = React.useState(30);
  const [figures, setFigures] = React.useState<SupportAnalytics | null>(null);
  const [settings, setSettings] = React.useState<SupportSettings | null>(null);
  const [error, setError] = React.useState("");
  const [asking, setAsking] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [analytics, current] = await Promise.all([api.analytics(days), api.settings()]);
      setFigures(analytics);
      setSettings(current.settings);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Could not load Support's figures"));
    }
  }, [api, days]);

  React.useEffect(() => {
    void load();
  }, [load]);
  useLiveRefetch(["support_ticket", "support_settings"], () => void load());

  async function requestReading() {
    setAsking(true);
    try {
      await api.requestInsights();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t ask for a reading" });
    } finally {
      setAsking(false);
    }
  }

  const insights = settings?.insights ?? null;
  return (
    <div className="page-shell p-4 sm:p-8">
      <PageHeader
        breadcrumbs={[
          { label: "Support", to: `/c/${company.slug}/support` },
          { label: "Insights" },
        ]}
        title="Insights"
        actions={
          <div className="w-36">
            <Select
              aria-label="Period"
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </Select>
          </div>
        }
      />
      {error ? (
        <EmptyState title="Figures could not be loaded" description={error} />
      ) : !figures ? (
        <SkeletonList rows={5} />
      ) : figures.tickets === 0 && !insights ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Nothing to report yet"
          description="Figures appear once tickets arrive in your Support inboxes."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label="Tickets"
              value={figures.tickets.toLocaleString()}
              hint={`${figures.backlog} open now`}
            />
            <Figure
              label="First reply"
              value={
                figures.medianFirstResponseMinutes === null
                  ? "—"
                  : durationText(figures.medianFirstResponseMinutes)
              }
              hint="Median"
            />
            <Figure
              label="Time to solve"
              value={
                figures.medianResolutionMinutes === null
                  ? "—"
                  : durationText(figures.medianResolutionMinutes)
              }
              hint="Median"
            />
            <Figure label="Met their target" value={percent(figures.slaAttainment)} />
            <Figure
              label="Solved by AI"
              value={percent(figures.ai.resolutionRate)}
              hint={`${figures.ai.solved} of ${figures.solved} solved tickets`}
            />
            <Figure
              label="Drafts sent untouched"
              value={percent(figures.ai.draftAcceptance)}
              hint={`${figures.ai.draftsUntouched} of ${figures.ai.draftsSent + figures.ai.draftsDiscarded} decided`}
            />
            <Figure
              label="Customer rating"
              value={figures.ratingAverage === null ? "—" : figures.ratingAverage.toFixed(1)}
              hint={
                figures.ratingCount
                  ? `${figures.ratingCount} ${figures.ratingCount === 1 ? "rating" : "ratings"}`
                  : "None yet"
              }
            />
            <Figure
              label="Frustrated or angry"
              value={(figures.sentiment.frustrated + figures.sentiment.angry).toLocaleString()}
              hint={`${figures.sentiment.angry} angry`}
            />
          </div>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Volume
            </h2>
            <VolumeChart volume={figures.volume} />
          </Card>

          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Sparkles
                  size={14}
                  className="text-violet-600 dark:text-violet-300"
                  aria-hidden="true"
                />
                What customers are running into
              </h2>
              <Button
                size="sm"
                variant="secondary"
                loading={asking}
                disabled={!settings?.aiEmployeeId}
                onClick={() => void requestReading()}
              >
                <RefreshCw size={13} /> Read again
              </Button>
            </div>
            {insights ? (
              <div className="mt-3 space-y-4">
                <p className="text-sm leading-6 text-slate-800 dark:text-slate-200">
                  {insights.summary}
                </p>
                {insights.themes.length > 0 && (
                  <ul className="space-y-2">
                    {insights.themes.map((theme) => (
                      <li
                        key={theme.title}
                        className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                            {theme.title}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                            {theme.ticketCount} {theme.ticketCount === 1 ? "ticket" : "tickets"}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                          {theme.detail}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {insights.recommendations.length > 0 && (
                  <div>
                    <h3 className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                      <Lightbulb size={12} aria-hidden="true" /> What to do
                    </h3>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700 dark:text-slate-300">
                      {insights.recommendations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Read from {insights.ticketCount}{" "}
                  {insights.ticketCount === 1 ? "ticket" : "tickets"} over {insights.windowDays}{" "}
                  days
                  {settings?.insightsAt ? `, ${agoText(settings.insightsAt)}` : ""}.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                {settings?.aiEmployeeId
                  ? "Your AI Employee reads recent tickets each week. Press Read again to have it look now."
                  : "Choose who works Support in its settings, and they will read recent tickets each week."}
              </p>
            )}
          </Card>

          {figures.topics.length > 0 && (
            <div>
              <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                By topic
              </h2>
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Where drafts go out untouched is where the AI has earned replying on its own.{" "}
                <Link to={`/c/${company.slug}/support/settings`} className="underline">
                  Change a topic&apos;s setting
                </Link>
              </p>
              <TableCard>
                <Table>
                  <THead>
                    <TR>
                      <TH>Topic</TH>
                      <TH className="text-right">Tickets</TH>
                      <TH className="text-right">Solved by AI</TH>
                      <TH className="text-right">Drafts untouched</TH>
                      <TH className="text-right">Discarded</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {figures.topics.map((topic) => (
                      <TR key={topic.key ?? "none"}>
                        <TD className="font-medium text-slate-900 dark:text-slate-100">
                          {topic.name}
                        </TD>
                        <TD className="text-right tabular-nums">{topic.tickets}</TD>
                        <TD className="text-right tabular-nums">{topic.solvedByAi}</TD>
                        <TD className="text-right tabular-nums">
                          {percent(topic.draftAcceptance)}
                        </TD>
                        <TD className="text-right tabular-nums">{topic.draftsDiscarded}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableCard>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
