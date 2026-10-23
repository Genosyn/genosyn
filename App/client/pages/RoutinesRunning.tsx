import { useNavigate, useOutletContext } from "react-router-dom";
import { Company } from "../lib/api";
import { newRoutinePath } from "../lib/newItemPath";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { RoutineActivity } from "@/components/routines/RoutineActivity";
import { RoutinesContext } from "./RoutinesLayout";

/**
 * Routines → Running: the company's Routine work as it happens — the Runs
 * under way, the Runs waiting in the queue, and what ran today. It used to sit
 * above the list of every Routine; on its own page the list stays a list to
 * search and file, and this one stays a glance at the work. It covers every
 * Routine: the sidebar's folders and employees filter the list, not this page.
 */
export default function RoutinesRunning({ company }: { company: Company }) {
  const { routines, loadError } = useOutletContext<RoutinesContext>();
  const navigate = useNavigate();

  return (
    <div className="page-shell p-6">
      <Breadcrumbs
        items={[{ label: "Routines", to: `/c/${company.slug}/routines` }, { label: "Running" }]}
      />
      <TopBar title="Running" />
      {/* A failed refresh cannot establish that every Routine was deleted. */}
      {loadError && routines.length === 0 ? null : routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          description="A routine is recurring work an AI employee performs on a schedule. Its Runs show here while they run, while they wait to start, and once they finish."
          action={
            <Button onClick={() => navigate(newRoutinePath(company.slug))}>New routine</Button>
          }
        />
      ) : (
        <RoutineActivity key={company.id} company={company} routines={routines} />
      )}
    </div>
  );
}
