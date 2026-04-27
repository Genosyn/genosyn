import React from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api, Company, Pipeline } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { PipelinesContext } from "./PipelinesLayout";

export default function PipelineNew({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { refresh } = useOutletContext<PipelinesContext>();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.post<Pipeline>(
        `/api/companies/${company.id}/pipelines`,
        { name: name.trim(), description: description.trim() || undefined },
      );
      await refresh();
      navigate(`/c/${company.slug}/pipelines/${created.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <Breadcrumbs
        items={[
          { label: company.name, to: `/c/${company.slug}` },
          { label: "Pipelines", to: `/c/${company.slug}/pipelines` },
          { label: "New" },
        ]}
      />
      <TopBar title="New pipeline" />
      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Notify support on new signup"
          autoFocus
          required
        />
        <Textarea
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this pipeline automate?"
          rows={3}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate(`/c/${company.slug}/pipelines`)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create pipeline"}
          </Button>
        </div>
      </form>
    </div>
  );
}
