import React from "react";
import { ArrowRight, Building2 } from "lucide-react";
import { api, type Company } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Textarea } from "@/components/ui/Textarea";
import { StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

export function CompanyStep({
  company,
  onSaved,
}: {
  company: Company;
  onSaved: () => Promise<void>;
}) {
  const [mission, setMission] = React.useState(company.mission);
  const [vision, setVision] = React.useState(company.vision);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!mission.trim() || !vision.trim()) {
      setError("Add a short mission and vision before hiring your AI Employee.");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/companies/${company.id}`, {
        mission: mission.trim(),
        vision: vision.trim(),
      });
      await onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard>
      <StepHeading
        icon={Building2}
        title="What is your company here to do?"
        description={`Give ${company.name} a little direction before hiring. A sentence for each is enough to help us suggest useful Routines.`}
      />
      <form className="mt-5 space-y-4" onSubmit={submit}>
        <Textarea
          label="Mission"
          value={mission}
          onChange={(event) => setMission(event.target.value)}
          placeholder="What do you do, for whom, and why?"
          rows={3}
          className="!min-h-24"
          maxLength={2000}
          required
          disabled={saving}
        />
        <Textarea
          label="Vision"
          value={vision}
          onChange={(event) => setVision(event.target.value)}
          placeholder="What should be true when the company succeeds?"
          rows={3}
          className="!min-h-24"
          maxLength={2000}
          required
          disabled={saving}
        />
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          You can refine these later in Settings → Company.
        </p>
        <FormError message={error} />
        <StepFooter>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={saving || company.role === "member"}
          >
            {saving ? "Saving…" : "Save and continue"}
            {!saving && <ArrowRight size={15} />}
          </Button>
        </StepFooter>
        {company.role === "member" && (
          <p className="text-sm text-slate-500">
            Ask a company owner or admin to add the mission and vision.
          </p>
        )}
      </form>
    </StepCard>
  );
}
