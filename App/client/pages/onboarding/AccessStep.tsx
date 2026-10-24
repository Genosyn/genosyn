import { ArrowRight, KeyRound } from "lucide-react";
import type { Company, Employee } from "../../lib/api";
import { EmployeeAccessPanel } from "../../components/employeeAccess/EmployeeAccessPanel";
import { Button } from "../../components/ui/Button";
import { StepCard, StepFooter, StepHeading } from "./OnboardingFrame";

/**
 * The guide's Access step: everything the company has that the new AI Employee
 * could be given, in one list, right after it is hired.
 *
 * An employee without a Grant sees nothing of a mailbox, a notebook or Finance,
 * so a new hire is only as useful as what it is granted — which is why this is
 * a step rather than something to find later. It is the same panel as the
 * employee's Settings → Access, and each Grant follows its own section's rules.
 * Nothing here is required: Continue works with nothing ticked.
 */
export function AccessStep({
  company,
  employee,
  onBack,
  onContinue,
}: {
  company: Company;
  employee: Employee;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <StepCard>
      <StepHeading
        icon={KeyRound}
        title={`Choose what ${employee.name} can reach`}
        description={
          <>
            Tick what the job needs — a mailbox, a notebook, Finance — and grant it in one go. Each
            Grant follows its own section&apos;s rules, and you can change any of it later on{" "}
            {employee.name}&apos;s Access page.
          </>
        }
      />
      <div className="my-5 border-t border-slate-100 dark:border-slate-800" />
      <EmployeeAccessPanel company={company} emp={employee} />
      <StepFooter onBack={onBack}>
        <Button className="w-full sm:w-auto" onClick={onContinue}>
          Finish setup <ArrowRight size={15} />
        </Button>
      </StepFooter>
    </StepCard>
  );
}
