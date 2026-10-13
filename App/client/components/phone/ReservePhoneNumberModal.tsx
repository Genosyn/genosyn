import React from "react";
import { MessageSquare, Phone, Search, TriangleAlert } from "lucide-react";
import type { Employee } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import {
  phoneApi,
  type AvailablePhoneNumber,
  type ImportablePhoneNumber,
  type PhoneConnectionSummary,
  type PhoneNumberRow,
} from "../../lib/phone";
import { formatPhoneNumber } from "../../../shared/phone";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { FormError } from "../ui/FormError";
import { Spinner } from "../ui/Spinner";
import { clsx } from "../ui/clsx";

/**
 * Get a phone number: search Twilio's inventory and reserve one, or bring in a
 * number the Twilio account already owns. Either way the number can be given
 * to an AI Employee in the same step.
 */

type Mode = "search" | "import";

const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "IE", name: "Ireland" },
  { code: "NZ", name: "New Zealand" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
  { code: "IN", name: "India" },
];

export function ReservePhoneNumberModal({
  open,
  companyId,
  connections,
  employees,
  defaultEmployeeId,
  onClose,
  onDone,
}: {
  open: boolean;
  companyId: string;
  connections: PhoneConnectionSummary[];
  employees: Employee[];
  defaultEmployeeId?: string | null;
  onClose: () => void;
  onDone: (number: PhoneNumberRow) => void;
}) {
  const [mode, setMode] = React.useState<Mode>("search");
  const [connectionId, setConnectionId] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState<string>("");
  const [label, setLabel] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setMode("search");
    setConnectionId(connections[0]?.id ?? "");
    setEmployeeId(defaultEmployeeId ?? "");
    setLabel("");
  }, [open, connections, defaultEmployeeId]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Get a phone number"
      description="Numbers are reserved in your Twilio account and billed there."
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div className="inline-flex self-start rounded-lg border border-slate-200 p-0.5 text-sm dark:border-slate-700">
          {(
            [
              ["search", "Find a new number"],
              ["import", "Use a number you own"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={clsx(
                "rounded-md px-3 py-1.5 font-medium",
                mode === value
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              {text}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {connections.length > 1 && (
            <Select
              label="Twilio account"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.accountHint ? ` — ${c.accountHint}` : ""}
                </option>
              ))}
            </Select>
          )}
          <Select
            label="Give it to"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">Nobody yet</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.role}
              </option>
            ))}
          </Select>
          <Input
            label="Name (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Support line"
            maxLength={80}
          />
        </div>

        {mode === "search" ? (
          <SearchPane
            companyId={companyId}
            connectionId={connectionId}
            employeeId={employeeId || null}
            label={label}
            onClose={onClose}
            onDone={onDone}
          />
        ) : (
          <ImportPane
            companyId={companyId}
            connectionId={connectionId}
            employeeId={employeeId || null}
            label={label}
            onClose={onClose}
            onDone={onDone}
          />
        )}
      </div>
    </Modal>
  );
}

function CapabilityBadges({ voice, sms }: { voice: boolean; sms: boolean }) {
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
      {sms && (
        <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
          <MessageSquare size={11} /> Texts
        </span>
      )}
      {voice && (
        <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
          <Phone size={11} /> Calls
        </span>
      )}
    </span>
  );
}

function SearchPane({
  companyId,
  connectionId,
  employeeId,
  label,
  onClose,
  onDone,
}: {
  companyId: string;
  connectionId: string;
  employeeId: string | null;
  label: string;
  onClose: () => void;
  onDone: (number: PhoneNumberRow) => void;
}) {
  const [country, setCountry] = React.useState("US");
  const [type, setType] = React.useState<"local" | "toll-free" | "mobile">("local");
  const [areaCode, setAreaCode] = React.useState("");
  const [contains, setContains] = React.useState("");
  const [results, setResults] = React.useState<AvailablePhoneNumber[] | null>(null);
  const [price, setPrice] = React.useState<{ amount: string; currency: string } | null>(null);
  const [picked, setPicked] = React.useState<string>("");
  const [searching, setSearching] = React.useState(false);
  const [reserving, setReserving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const search = async () => {
    if (!connectionId) return;
    setSearching(true);
    setError(null);
    setPicked("");
    try {
      const found = await phoneApi.search(companyId, {
        connectionId,
        country,
        type,
        areaCode: areaCode.trim() || undefined,
        contains: contains.trim() || undefined,
      });
      setResults(found.numbers);
      setPrice(found.monthlyPrice);
      if (found.numbers.length > 0) setPicked(found.numbers[0].phoneNumber);
    } catch (err) {
      setResults(null);
      setError(errorMessage(err, "Could not search Twilio"));
    } finally {
      setSearching(false);
    }
  };

  const reserve = async () => {
    const choice = results?.find((r) => r.phoneNumber === picked);
    if (!choice) return;
    setReserving(true);
    setError(null);
    try {
      const number = await phoneApi.reserve(companyId, {
        connectionId,
        phoneNumber: choice.phoneNumber,
        employeeId,
        label,
        country: choice.country,
        locality: [choice.locality, choice.region].filter(Boolean).join(", "),
      });
      onDone(number);
    } catch (err) {
      setError(errorMessage(err, "Could not reserve the number"));
    } finally {
      setReserving(false);
    }
  };

  const choice = results?.find((r) => r.phoneNumber === picked);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_0.8fr_0.8fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="Type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="local">Local</option>
          <option value="toll-free">Toll-free</option>
          <option value="mobile">Mobile</option>
        </Select>
        <Input
          label="Area code"
          value={areaCode}
          onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="415"
          inputMode="numeric"
        />
        <Input
          label="Contains"
          value={contains}
          onChange={(e) => setContains(e.target.value.replace(/[^0-9A-Za-z*]/g, "").slice(0, 16))}
          placeholder="777"
        />
        <Button type="submit" variant="secondary" loading={searching} disabled={!connectionId}>
          {!searching && <Search size={14} />} Search
        </Button>
      </form>

      <FormError message={error} />

      {searching && results === null ? (
        <Spinner />
      ) : results === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Search to see the numbers Twilio has available.
        </p>
      ) : results.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No numbers match. Try another area code, or leave it blank.
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {results.map((r) => (
              <li key={r.phoneNumber}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <input
                    type="radio"
                    name="available-number"
                    checked={picked === r.phoneNumber}
                    onChange={() => setPicked(r.phoneNumber)}
                  />
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {formatPhoneNumber(r.phoneNumber)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">
                    {[r.locality, r.region].filter(Boolean).join(", ")}
                  </span>
                  <CapabilityBadges voice={r.voice} sms={r.sms} />
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {choice && choice.addressRequirements !== "none" && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          Twilio requires a registered address for this number. Add one in Twilio Console before
          reserving it.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {price
            ? `About ${price.currency === "USD" ? "$" : `${price.currency} `}${price.amount} a month, plus texts and minutes — billed by Twilio.`
            : "Billed monthly by Twilio, plus texts and minutes."}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={reserving}>
            Cancel
          </Button>
          <Button type="button" onClick={reserve} loading={reserving} disabled={!choice}>
            Reserve number
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImportPane({
  companyId,
  connectionId,
  employeeId,
  label,
  onClose,
  onDone,
}: {
  companyId: string;
  connectionId: string;
  employeeId: string | null;
  label: string;
  onClose: () => void;
  onDone: (number: PhoneNumberRow) => void;
}) {
  const [numbers, setNumbers] = React.useState<ImportablePhoneNumber[] | null>(null);
  const [picked, setPicked] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    setNumbers(null);
    setError(null);
    phoneApi
      .importable(companyId, connectionId)
      .then((list) => {
        if (cancelled) return;
        setNumbers(list);
        setPicked(list[0]?.sid ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setNumbers([]);
        setError(errorMessage(err, "Could not list the numbers on this Twilio account"));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, connectionId]);

  const choice = numbers?.find((n) => n.sid === picked);

  const use = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        await phoneApi.import(companyId, { connectionId, sid: choice.sid, employeeId, label }),
      );
    } catch (err) {
      setError(errorMessage(err, "Could not bring the number in"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <FormError message={error} />
      {numbers === null ? (
        <Spinner />
      ) : numbers.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          This Twilio account has no numbers that are not already in Genosyn.
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {numbers.map((n) => (
              <li key={n.sid}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <input
                    type="radio"
                    name="owned-number"
                    checked={picked === n.sid}
                    onChange={() => setPicked(n.sid)}
                  />
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {n.display}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">
                    {n.friendlyName !== n.e164 ? n.friendlyName : ""}
                  </span>
                  <CapabilityBadges voice={n.capabilities.voice} sms={n.capabilities.sms} />
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {choice?.configuredElsewhere && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          Twilio sends this number&apos;s texts or calls somewhere else today. Using it here points
          them at Genosyn instead.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={use} loading={busy} disabled={!choice}>
          Use this number
        </Button>
      </div>
    </div>
  );
}
