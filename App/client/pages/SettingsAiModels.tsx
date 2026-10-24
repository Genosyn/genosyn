import React from "react";
import { useOutletContext } from "react-router-dom";
import { Copy, Plus } from "lucide-react";
import { api, type AIModel, type Company } from "../lib/api";
import {
  companyModelPath,
  duplicateGroups,
  mergeSummary,
  nameList,
  type DuplicateGroup,
} from "../lib/companyModels";
import { errorMessage } from "../lib/errors";
import { describeModel } from "../lib/modelSummary";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { useDialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { ModelCard } from "../components/models/ModelCard";
import { ModelSetupForm } from "../components/models/ModelSetupForm";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → AI Models. Every AI Model the company has connected, who runs on
 * each, and everything about one in its card: Test connection, attaching it to
 * AI Employees (one model, any number of employees, one set of keys), its keys
 * and settings, and removing it — which asks first, and while anyone uses it
 * only goes by detaching it from all of them. Copies of one model with the
 * same keys are offered for merging rather than merged on their own.
 *
 * Owners and admins only, like every change to a model: a Member arriving by
 * URL is told so, and each AI Employee's own Model page still shows what it
 * runs on.
 */
export function SettingsAiModels() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  if (!canOpenSubpage(subpageAt("/settings/ai-models"), company)) return <AiModelsClosed />;
  return <CompanyAiModels company={company} />;
}

/** What a Member sees at Settings → AI Models. */
export function AiModelsClosed() {
  return (
    <>
      <TopBar title="AI Models" />
      <EmptyState
        title="Only owners and admins manage AI Models"
        description="AI Models hold the company's keys, so owners and admins connect them and choose which AI Employees use each. An AI Employee's own Model page shows what it runs on."
      />
    </>
  );
}

/** The company's AI Models, for an owner or admin. */
export function CompanyAiModels({ company }: { company: Pick<Company, "id" | "role" | "slug"> }) {
  const [models, setModels] = React.useState<AIModel[] | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setModels(await api.get<AIModel[]>(companyModelPath(company.id)));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [company.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);
  // A model change, an attachment, or an employee joining or leaving.
  useLiveRefetch("employee", reload);

  const addButton = !adding && (
    <Button onClick={() => setAdding(true)}>
      <Plus size={14} /> Add an AI Model
    </Button>
  );

  return (
    <>
      <TopBar title="AI Models" right={models && models.length > 0 ? addButton : undefined} />
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          The brains your AI Employees run on. Connect a model once — its key, endpoint or ChatGPT
          sign-in — and attach it to as many AI Employees as you like: they share one set of keys,
          settings and Run limit. Each AI Employee uses one of its models at a time.
        </p>
        {loadError && (
          <div className="flex flex-col items-start gap-3">
            <FormError message={loadError} />
            <Button variant="secondary" onClick={() => void reload()}>
              Try loading AI Models again
            </Button>
          </div>
        )}
        {adding && (
          <AddCompanyModelPanel
            company={company}
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void reload();
            }}
          />
        )}
        {models === undefined ? (
          !loadError && <Spinner />
        ) : models.length === 0 ? (
          !adding && (
            <EmptyState
              title="No AI Models yet"
              description="Connect a Claude or OpenAI key, a ChatGPT sign-in, or a server you run yourself. Then attach it to the AI Employees who should think with it."
              action={addButton}
            />
          )
        ) : (
          <>
            {duplicateGroups(models).map((group) => (
              <DuplicateNotice
                key={group.keep.id}
                company={company}
                group={group}
                onMerged={() => void reload()}
              />
            ))}
            {models.map((model) => (
              <ModelCard
                key={model.id}
                company={company}
                model={model}
                companyModels={models}
                onChanged={() => void reload()}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** Connecting a new company model, from the page's own button. */
function AddCompanyModelPanel({
  company,
  onCancel,
  onAdded,
}: {
  company: Pick<Company, "id">;
  onCancel: () => void;
  onAdded: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Add an AI Model
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Once it is connected, attach it to the AI Employees who should use it.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <ModelSetupForm
          mode="create"
          initial={{ provider: "anthropic", model: "", authMode: "apikey" }}
          company={company}
          onSaved={onAdded}
          submitLabel="Add AI Model"
        />
      </CardBody>
    </Card>
  );
}

/**
 * Copies of one model with the same keys — usually left from when every AI
 * Employee kept its own copy — offered for merging into one. Nothing merges
 * until an owner presses it, and the dialog says what stays.
 */
function DuplicateNotice({
  company,
  group,
  onMerged,
}: {
  company: Pick<Company, "id">;
  group: DuplicateGroup;
  onMerged: () => void;
}) {
  const dialog = useDialog();
  const [merging, setMerging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const copies = group.duplicates.length + 1;
  const users = [
    ...new Set(
      [group.keep, ...group.duplicates].flatMap((model) => model.employees.map((user) => user.name)),
    ),
  ];

  async function merge() {
    const summary = mergeSummary(group);
    const ok = await dialog.confirm({
      title: summary.title,
      message: summary.message,
      confirmLabel: summary.confirmLabel,
    });
    if (!ok) return;
    setError(null);
    setMerging(true);
    try {
      await api.post(companyModelPath(company.id, group.keep.id, "/merge"), {
        duplicateIds: group.duplicates.map((model) => model.id),
      });
      onMerged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMerging(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Copy size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-medium">
              {copies} copies of {describeModel(group.keep)} with the same keys
            </div>
            <div className="text-xs text-amber-800 dark:text-amber-200">
              {users.length > 0 ? `Used by ${nameList(users)}. ` : ""}
              Merge them so one set of keys serves everyone, and a key changed once is changed
              for all.
            </div>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={merge} loading={merging}>
          Merge into one
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}
