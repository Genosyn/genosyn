import React from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Lightbulb,
  ListPlus,
  Mail,
  Play,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { api, type Company, type Pipeline } from "@/lib/api";
import type { PipelinesContext } from "@/pages/PipelinesLayout";

type StartWith = "manual" | "schedule" | "webhook" | "emailReceived" | "todoCreated";

const STARTERS: Array<{
  id: StartWith;
  title: string;
  description: string;
  example: string;
  icon: LucideIcon;
}> = [
  {
    id: "manual",
    title: "A Member clicks Run now",
    description: "Best for one-off work, admin tools, and testing a new pipeline.",
    example: "Example: prepare the weekly report on demand",
    icon: Play,
  },
  {
    id: "schedule",
    title: "A schedule is reached",
    description: "Best for regular work that should happen without a reminder.",
    example: "Example: post a summary every weekday at 9am",
    icon: CalendarClock,
  },
  {
    id: "webhook",
    title: "Another system sends data",
    description: "Best for reacting immediately to an event in another product.",
    example: "Example: create a task when a form is submitted",
    icon: Webhook,
  },
  {
    id: "emailReceived",
    title: "An email is received",
    description: "Best for inbox triage, follow-up, and turning messages into structured work.",
    example: "Example: alert the team when an invoice arrives",
    icon: Mail,
  },
  {
    id: "todoCreated",
    title: "A task is created",
    description: "Best for Project handoffs, routing, notifications, and consistent follow-up.",
    example: "Example: post urgent new tasks to a channel",
    icon: ListPlus,
  },
];

export default function PipelineNew({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { refresh } = useOutletContext<PipelinesContext>();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [startWith, setStartWith] = React.useState<StartWith>("manual");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.post<Pipeline>(`/api/companies/${company.id}/pipelines`, {
        name: name.trim(),
        description: description.trim() || undefined,
        startWith,
      });
      await refresh();
      navigate(`/c/${company.slug}/pipelines/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <Breadcrumbs
        items={[
          { label: company.name, to: `/c/${company.slug}` },
          { label: "Pipelines", to: `/c/${company.slug}/pipelines` },
          { label: "New pipeline" },
        ]}
      />

      <header className="mt-4 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-slate-50">
          Create a pipeline
        </h1>
        <p className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-400">
          Give the automation a clear purpose and choose what starts it. You will add and connect
          the steps on the next screen.
        </p>
      </header>

      <form onSubmit={submit} className="mt-7 space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
              1
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-slate-950 dark:text-slate-50">Name the outcome</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                A specific name makes the pipeline easy to find and understand later.
              </p>
              <div className="mt-4 space-y-4">
                <div>
                  <Input
                    label="Pipeline name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Create a support task from a new form response"
                    maxLength={80}
                    autoFocus
                    required
                  />
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                    Start with a verb and describe the result, not the technology.
                  </p>
                </div>
                <div>
                  <Textarea
                    label="Purpose (optional)"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Explain when this should run and what a successful result looks like."
                    maxLength={500}
                    rows={3}
                    className="min-h-24"
                  />
                  <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <span>This appears on the Pipelines overview.</span>
                    <span className="tabular-nums">{description.length}/500</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
              2
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-slate-950 dark:text-slate-50">
                How should it start?
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                This creates the first trigger. You can change it or add more later.
              </p>
              <div className="mt-4 grid gap-3">
                {STARTERS.map((starter) => {
                  const Icon = starter.icon;
                  const selected = startWith === starter.id;
                  return (
                    <label
                      key={starter.id}
                      className={
                        "relative flex cursor-pointer gap-3 rounded-xl border p-4 transition " +
                        (selected
                          ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-100 dark:border-indigo-600 dark:bg-indigo-500/10 dark:ring-indigo-950"
                          : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-900")
                      }
                    >
                      <input
                        type="radio"
                        name="startWith"
                        value={starter.id}
                        checked={selected}
                        onChange={() => setStartWith(starter.id)}
                        className="sr-only"
                      />
                      <div
                        className={
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
                          (selected
                            ? "bg-indigo-600 text-white"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                        }
                      >
                        <Icon size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {starter.title}
                          </span>
                          {selected && (
                            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-white">
                              <Check size={12} />
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                          {starter.description}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                          {starter.example}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800 dark:bg-slate-900">
          <div className="flex max-w-md items-start gap-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-amber-500" />
            <span>
              Next, the builder will show exactly what is missing before the pipeline can run.
            </span>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate(`/c/${company.slug}/pipelines`)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Open builder"}
              {!busy && <ArrowRight size={15} />}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
