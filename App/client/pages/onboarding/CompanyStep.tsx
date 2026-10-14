import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Target } from "lucide-react";
import { api, type Company, type Goal } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { buildGoalPayload } from "@/lib/goalSentence";
import { goalStandingLine, primaryGoal } from "@/lib/goalSummary";
import { hasCompanyDirection } from "@/lib/onboardingFlow";
import { StepCard, StepFooter, StepHeading } from "./OnboardingFrame";
import { GoalFields, MissionVisionFields, useGoalDraft } from "./GoalFields";

/**
 * The guide's first step, and the gate in front of the hire wizard: write the
 * company's Goal. A company that already has one sees it here and can add a
 * mission and vision; one that has neither is asked for the Goal.
 */
export function CompanyStep({
  company,
  onSaved,
}: {
  company: Company;
  onSaved: () => Promise<void>;
}) {
  const goal = useGoalDraft();
  const [mission, setMission] = React.useState(company.mission);
  const [vision, setVision] = React.useState(company.vision);
  const [existing, setExisting] = React.useState<Goal | null | undefined>(
    company.hasGoal ? undefined : null,
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Once the Goal is written it must not be written again by a retry after a
  // later step of the same save failed.
  const goalWritten = React.useRef(false);
  const canEdit = company.role !== "member";
  const hasGoal = Boolean(company.hasGoal);
  // A company with a mission and a vision can go on without a Goal; one with
  // neither has to write it.
  const goalRequired = !hasCompanyDirection(company);

  // The Goal the company already has, to show instead of asking again.
  React.useEffect(() => {
    if (!company.hasGoal) {
      setExisting(null);
      return;
    }
    let cancelled = false;
    setExisting(undefined);
    api
      .get<Goal[]>(`/api/companies/${company.id}/goals`)
      .then((goals) => {
        if (!cancelled) setExisting(primaryGoal(goals));
      })
      .catch(() => {
        if (!cancelled) setExisting(null);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, company.hasGoal]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const writingGoal = !hasGoal && (goalRequired || goal.draft.sentence.trim() !== "");
    const built = writingGoal ? buildGoalPayload(goal.draft) : null;
    if (built && !built.ok) {
      setError(built.error);
      return;
    }
    const profile: { mission?: string; vision?: string } = {};
    if (mission.trim() !== company.mission.trim()) profile.mission = mission.trim();
    if (vision.trim() !== company.vision.trim()) profile.vision = vision.trim();
    setSaving(true);
    try {
      // Mission and vision first: saving them again on a retry changes nothing,
      // while a Goal written twice would be two Goals.
      if (Object.keys(profile).length > 0) {
        await api.patch(`/api/companies/${company.id}`, profile);
      }
      if (built?.ok && !goalWritten.current) {
        await api.post<Goal>(`/api/companies/${company.id}/goals`, built.goal);
        goalWritten.current = true;
      }
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <StepCard>
      <StepHeading
        icon={Target}
        title={hasGoal ? `${company.name}'s Goal` : "What is your company's Goal?"}
        description={
          hasGoal
            ? "Every AI Employee you hire reads it before they work."
            : `Give ${company.name} one Goal: a direction and a number. Every AI Employee you hire will work toward it.`
        }
      />
      <form className="mt-5 space-y-4" onSubmit={submit}>
        {hasGoal ? (
          <ExistingGoal company={company} goal={existing} />
        ) : (
          <GoalFields goal={goal} disabled={saving || !canEdit} autoFocus={canEdit} />
        )}
        <MissionVisionFields
          mission={mission}
          vision={vision}
          onMission={setMission}
          onVision={setVision}
          disabled={saving || !canEdit}
          defaultOpen={Boolean(company.mission.trim() || company.vision.trim())}
        />
        <FormError message={error} />
        <StepFooter>
          <Button type="submit" className="w-full sm:w-auto" loading={saving} disabled={!canEdit}>
            {saving ? "Saving…" : "Save and continue"}
            {!saving && <ArrowRight size={15} />}
          </Button>
        </StepFooter>
        {!canEdit && (
          <p className="text-sm text-slate-500">Ask a company owner or admin to set the Goal.</p>
        )}
      </form>
    </StepCard>
  );
}

function ExistingGoal({ company, goal }: { company: Company; goal: Goal | null | undefined }) {
  if (goal === undefined) {
    return (
      <div className="flex justify-center py-4" role="status" aria-label="Loading your Goal">
        <Spinner size={18} />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/40">
      {goal ? (
        <>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{goal.title}</div>
          <div className="mt-0.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {goalStandingLine(goal)}
          </div>
        </>
      ) : (
        <div className="text-sm text-slate-600 dark:text-slate-300">Your Goal is set.</div>
      )}
      <Link
        to={`/c/${company.slug}/goals`}
        className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
      >
        Edit in Goals
      </Link>
    </div>
  );
}
