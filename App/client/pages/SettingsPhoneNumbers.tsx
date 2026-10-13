import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { MessageSquare, Phone, Plus, TriangleAlert } from "lucide-react";
import { api, type Company, type Employee } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { phoneApi, type PhoneNumberRow, type PhoneSetup } from "../lib/phone";
import { canOpenSubpage, subpageAt } from "../lib/subpages";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
import { ReservePhoneNumberModal } from "../components/phone/ReservePhoneNumberModal";
import { PhoneSetupNotice } from "../components/phone/PhoneSetupNotice";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → Phone numbers. Every Twilio number the company holds, who has
 * it, and what a call or a text to it does. Owner/admin only: numbers cost
 * money and their texts carry verification codes.
 */
export function SettingsPhoneNumbers() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  // Admin-only on the server. A Member arrives only by URL, since the rail and
  // the palette leave the page out, so they get a note in place of the list,
  // which never mounts to send a request that could only answer 403.
  if (!canOpenSubpage(subpageAt("/settings/phone-numbers"), company)) {
    return <PhoneNumbersClosed />;
  }
  return <PhoneNumbersList company={company} />;
}

/** What a Member sees at either Phone numbers page. */
export function PhoneNumbersClosed() {
  return (
    <>
      <TopBar title="Phone numbers" />
      <EmptyState
        title="Only owners and admins manage phone numbers"
        description="Numbers cost the company money, and their texts carry the verification codes for the accounts AI Employees sign into. Ask an owner or admin if an AI Employee needs a number."
      />
    </>
  );
}

function PhoneNumbersList({ company }: { company: Company }) {
  const navigate = useNavigate();
  const [setup, setSetup] = React.useState<PhoneSetup | null>(null);
  const [numbers, setNumbers] = React.useState<PhoneNumberRow[] | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [reserving, setReserving] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const [s, n] = await Promise.all([phoneApi.setup(company.id), phoneApi.numbers(company.id)]);
      setSetup(s);
      setNumbers(n);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load phone numbers"));
      setNumbers((current) => current ?? []);
    }
  }, [company.id]);

  React.useEffect(() => {
    void reload();
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [company.id, reload]);
  useLiveRefetch(["phone", "connection", "employee"], reload);

  const canReserve = (setup?.connections.length ?? 0) > 0;

  return (
    <>
      <TopBar
        title="Phone numbers"
        right={
          canReserve ? (
            <Button onClick={() => setReserving(true)}>
              <Plus size={14} /> Get a number
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Give AI Employees their own phone numbers. An employee texts and calls from its number,
          reads the texts that arrive — verification codes included — and answers calls following
          the instructions you write here.
        </p>
        <FormError message={error} />
        {setup && <PhoneSetupNotice companySlug={company.slug} setup={setup} />}
        {numbers === null ? (
          <Spinner />
        ) : numbers.length === 0 ? (
          canReserve ? (
            <EmptyState
              title="No phone numbers yet"
              description="Reserve a number from Twilio, or bring in one your Twilio account already owns, and give it to an AI Employee."
              action={
                <Button onClick={() => setReserving(true)}>
                  <Plus size={14} /> Get a number
                </Button>
              }
            />
          ) : null
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {numbers.map((n) => (
              <li key={n.id}>
                <Link
                  to={`/c/${company.slug}/settings/phone-numbers/${n.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium tabular-nums text-slate-900 dark:text-slate-100">
                      {n.display}
                    </span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {[n.label, n.locality].filter(Boolean).join(" · ") || "Twilio number"}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {n.capabilities.sms && (
                      <span title="Texts" className="inline-flex items-center gap-0.5">
                        <MessageSquare size={12} /> {n.textMode === "reply" ? "Replies" : "Inbox"}
                      </span>
                    )}
                    {n.capabilities.voice && (
                      <span title="Calls" className="ml-2 inline-flex items-center gap-0.5">
                        <Phone size={12} />{" "}
                        {n.callMode === "answer"
                          ? "Answers"
                          : n.callMode === "forward"
                            ? "Forwards"
                            : "Declines"}
                      </span>
                    )}
                  </span>
                  <span className="flex w-48 min-w-0 items-center gap-2 text-sm">
                    {n.employee ? (
                      <>
                        <Avatar
                          name={n.employee.name}
                          kind="ai"
                          size="sm"
                          src={employeeAvatarUrl(
                            company.id,
                            n.employee.id,
                            employees.find((e) => e.id === n.employee?.id)?.avatarKey,
                          )}
                        />
                        <span className="truncate text-slate-700 dark:text-slate-200">
                          {n.employee.name}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">Unassigned</span>
                    )}
                  </span>
                  {n.connection && n.connection.status !== "connected" ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"
                      title="Twilio refused this account's credentials. Reconnect it at Settings → Integrations."
                    >
                      <TriangleAlert size={12} /> Reconnect Twilio
                    </span>
                  ) : (
                    (n.webhooks.state === "error" || n.webhooks.state === "outdated") && (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"
                        title={n.webhooks.error || "Twilio still calls an older address"}
                      >
                        <TriangleAlert size={12} /> Webhooks
                      </span>
                    )
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {setup && (
        <ReservePhoneNumberModal
          open={reserving}
          companyId={company.id}
          connections={setup.connections}
          employees={employees}
          onClose={() => setReserving(false)}
          onDone={(number) => {
            setReserving(false);
            navigate(`/c/${company.slug}/settings/phone-numbers/${number.id}`);
          }}
        />
      )}
    </>
  );
}
