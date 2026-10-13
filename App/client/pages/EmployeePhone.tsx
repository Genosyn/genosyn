import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { ArrowUpRight, Plus } from "lucide-react";
import { api, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { phoneApi, type PhoneNumberRow, type PhoneSetup } from "../lib/phone";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { PhoneActivity } from "../components/phone/PhoneActivity";
import { PhoneSetupNotice } from "../components/phone/PhoneSetupNotice";
import { ReservePhoneNumberModal } from "../components/phone/ReservePhoneNumberModal";
import type { EmployeeOutletCtx } from "./EmployeeLayout";

/**
 * An AI Employee's Phone pane: the numbers it has, and what happened on them.
 * Settings for each number live on the number's own page under Settings →
 * Phone numbers; this is the per-employee view of the same rows.
 */
export function EmployeePhone() {
  const { company, emp } = useOutletContext<EmployeeOutletCtx>();
  const admin = company.role === "owner" || company.role === "admin";

  if (!admin) {
    return (
      <>
        <TopBar title="Phone" />
        <EmptyState
          title="Owners and admins manage phone numbers"
          description={`Ask an owner or admin to give ${emp.name} a phone number. Texts and calls are only visible to them, because texts carry verification codes.`}
        />
      </>
    );
  }
  return <EmployeePhoneAdmin companyId={company.id} companySlug={company.slug} emp={emp} />;
}

function EmployeePhoneAdmin({
  companyId,
  companySlug,
  emp,
}: {
  companyId: string;
  companySlug: string;
  emp: Employee;
}) {
  const navigate = useNavigate();
  const [setup, setSetup] = React.useState<PhoneSetup | null>(null);
  const [numbers, setNumbers] = React.useState<PhoneNumberRow[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reserving, setReserving] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const [s, n] = await Promise.all([
        phoneApi.setup(companyId),
        phoneApi.numbers(companyId, emp.id),
      ]);
      setSetup(s);
      setNumbers(n);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load phone numbers"));
      setNumbers((current) => current ?? []);
    }
  }, [companyId, emp.id]);

  React.useEffect(() => {
    void reload();
    api
      .get<Employee[]>(`/api/companies/${companyId}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [companyId, reload]);
  useLiveRefetch(["phone", "connection"], reload);

  const canReserve = (setup?.connections.length ?? 0) > 0;

  return (
    <>
      <TopBar
        title="Phone"
        right={
          canReserve ? (
            <Button onClick={() => setReserving(true)}>
              <Plus size={14} /> Get a number
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <FormError message={error} />
        {setup && <PhoneSetupNotice companySlug={companySlug} setup={setup} />}
        {numbers === null ? (
          <Spinner />
        ) : numbers.length === 0 ? (
          canReserve ? (
            <EmptyState
              title={`${emp.name} has no phone number`}
              description={`Give ${emp.name} a number to text, receive verification codes, and answer and place calls.`}
              action={
                <Button onClick={() => setReserving(true)}>
                  <Plus size={14} /> Get a number
                </Button>
              }
            />
          ) : null
        ) : (
          numbers.map((n) => (
            <Card key={n.id}>
              <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {n.display}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {[
                      n.label,
                      n.callMode === "answer"
                        ? `${emp.name} answers calls`
                        : n.callMode === "forward"
                          ? "Calls are forwarded"
                          : "Calls are declined",
                      n.textMode === "reply" ? `${emp.name} replies to texts` : "Texts are kept",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Link
                  to={`/c/${companySlug}/settings/phone-numbers/${n.id}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Settings <ArrowUpRight size={13} />
                </Link>
              </CardHeader>
              <CardBody>
                <PhoneActivity companyId={companyId} number={n} />
              </CardBody>
            </Card>
          ))
        )}
      </div>
      {setup && (
        <ReservePhoneNumberModal
          open={reserving}
          companyId={companyId}
          connections={setup.connections}
          employees={employees}
          defaultEmployeeId={emp.id}
          onClose={() => setReserving(false)}
          onDone={(number) => {
            setReserving(false);
            if (number.employee?.id === emp.id) void reload();
            else navigate(`/c/${companySlug}/settings/phone-numbers/${number.id}`);
          }}
        />
      )}
    </>
  );
}
