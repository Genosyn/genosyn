import React from "react";
import {
  ArrowRight,
  CheckCircle2,
  CirclePlay,
  Clock3,
  Plus,
  Webhook,
  Workflow,
} from "lucide-react";
import { Link, useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import type { Company, Pipeline } from "@/lib/api";
import type { PipelinesContext } from "@/pages/PipelinesLayout";
import {
  formatRelativeTime,
  getPipelineIssues,
  pipelineStatus,
  pipelineTriggerSummary,
} from "@/pages/pipelines/pipelineUi";

export default function PipelinesIndex({ company }: { company: Company }) {
  const { pipelines, catalog, loading, error, refresh } = useOutletContext<PipelinesContext>();

  const readyCount = pipelines.filter(
    (pipeline) =>
      pipeline.enabled &&
      getPipelineIssues(pipeline.graph, catalog).every((issue) => issue.severity !== "error"),
  ).length;
  const scheduledCount = pipelines.filter((pipeline) => pipeline.cronExpr).length;

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
      <Breadcrumbs
        items={[{ label: company.name, to: `/c/${company.slug}` }, { label: "Pipelines" }]}
      />

      <header className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
            Pipelines
          </h1>
          <p className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-400">
            Connect a trigger to a series of predictable steps. Pipelines are best for repeatable
            work where the same input should follow the same path every time.
          </p>
        </div>
        <Link to={`/c/${company.slug}/pipelines/new`} className="shrink-0">
          <Button>
            <Plus size={15} /> Create pipeline
          </Button>
        </Link>
      </header>

      <MentalModel />

      {loading ? (
        <PipelineGridSkeleton />
      ) : error ? (
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
          <div className="font-semibold">Pipelines could not be loaded</div>
          <p className="mt-1">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : pipelines.length === 0 ? (
        <FirstPipeline company={company} />
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryCard label="Total" value={pipelines.length} helper="Pipelines" />
            <SummaryCard label="Ready" value={readyCount} helper="Can run now" />
            <SummaryCard
              label="Scheduled"
              value={scheduledCount}
              helper="Run automatically"
              className="col-span-2 sm:col-span-1"
            />
          </div>

          <div className="mb-3 mt-8 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              All pipelines
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {pipelines.length} total
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {pipelines.map((pipeline) => (
              <PipelineCard
                key={pipeline.id}
                company={company}
                pipeline={pipeline}
                catalog={catalog}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MentalModel() {
  const items = [
    {
      label: "1. Start",
      title: "Something happens",
      description: "A Member clicks, a schedule arrives, or another app calls a webhook.",
      icon: CirclePlay,
    },
    {
      label: "2. Do",
      title: "Connected steps run",
      description: "Each step can use the trigger data and outputs from earlier steps.",
      icon: Workflow,
    },
    {
      label: "3. Check",
      title: "The result is recorded",
      description: "Run history shows what succeeded, what failed, and the data produced.",
      icon: CheckCircle2,
    },
  ];
  return (
    <section className="mt-7 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:p-5">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:items-center">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <React.Fragment key={item.label}>
              <div className="flex gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 dark:bg-slate-950 dark:text-indigo-300 dark:ring-slate-700">
                  <Icon size={17} />
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
                    {item.label}
                  </div>
                  <div className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {item.title}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {item.description}
                  </p>
                </div>
              </div>
              {index < items.length - 1 && (
                <ArrowRight
                  size={17}
                  className="hidden text-slate-300 dark:text-slate-600 lg:block"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
}

function FirstPipeline({ company }: { company: Company }) {
  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="p-6 text-center sm:p-9">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Workflow size={22} />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-950 dark:text-slate-50">
          Build your first predictable automation
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-400">
          Choose how it starts, add the work it should do, then run it once to check the result. The
          builder will point out anything that still needs setup.
        </p>
        <Link to={`/c/${company.slug}/pipelines/new`} className="mt-5 inline-block">
          <Button>
            <Plus size={15} /> Create your first pipeline
          </Button>
        </Link>
      </div>
      <div className="grid border-t border-slate-100 bg-slate-50 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-900/60">
        <Example icon={CirclePlay} title="Manual" text="Run reports or admin tasks on demand." />
        <Example
          icon={Clock3}
          title="Scheduled"
          text="Send a daily brief or sync records each hour."
        />
        <Example icon={Webhook} title="Webhook" text="React when another product sends new data." />
      </div>
    </section>
  );
}

function Example({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof CirclePlay;
  title: string;
  text: string;
}) {
  return (
    <div className="border-b border-slate-100 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 dark:border-slate-800">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
        <Icon size={15} className="text-indigo-500" /> {title}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</p>
    </div>
  );
}

function PipelineCard({
  company,
  pipeline,
  catalog,
}: {
  company: Company;
  pipeline: Pipeline;
  catalog: PipelinesContext["catalog"];
}) {
  const status = pipelineStatus(pipeline, catalog);
  const stepCount = pipeline.graph.nodes.filter((node) => !node.type.startsWith("trigger.")).length;
  return (
    <Link
      to={`/c/${company.slug}/pipelines/${pipeline.slug}`}
      className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-950 dark:hover:border-indigo-700"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Workflow size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate font-semibold text-slate-950 group-hover:text-indigo-700 dark:text-slate-50 dark:group-hover:text-indigo-300">
              {pipeline.name}
            </h3>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.tone}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-slate-500 dark:text-slate-400">
            {pipeline.description || "No purpose has been added yet."}
          </p>
        </div>
      </div>
      <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-900">
        <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
          {pipelineTriggerSummary(pipeline)}
        </div>
        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          {stepCount} {stepCount === 1 ? "step" : "steps"} after the trigger
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span
          title={pipeline.lastRunAt ? new Date(pipeline.lastRunAt).toLocaleString() : undefined}
        >
          Last run: {formatRelativeTime(pipeline.lastRunAt)}
        </span>
        {pipeline.nextRunAt && (
          <span title={new Date(pipeline.nextRunAt).toLocaleString()}>
            Next run: {formatRelativeTime(pipeline.nextRunAt)}
          </span>
        )}
      </div>
    </Link>
  );
}

function SummaryCard({
  label,
  value,
  helper,
  className = "",
}: {
  label: string;
  value: number;
  helper: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 ${className}`}
    >
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-950 dark:text-slate-50">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-400">{helper}</div>
    </div>
  );
}

function PipelineGridSkeleton() {
  return (
    <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Loading pipelines">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-52 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
        />
      ))}
    </div>
  );
}
