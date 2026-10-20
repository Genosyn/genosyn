import React from "react";
import { AlertTriangle } from "lucide-react";
import { Account, api, CardCategoryDrift, Company, formatMoney } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { canWriteFinance } from "../lib/subpages";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { Modal } from "../components/ui/Modal";
import { transactionDate } from "./FinanceBankingTransaction";

/**
 * Card purchases whose books don't match the category Banking shows, from
 * before Banking was the one place it changes (`services/cardCategoryRepair.ts`).
 *
 * A notice above the list says how many there are. Review opens each one: the
 * category Banking shows, where the books hold it, and the one entry Fix
 * posts — dated today — so only Banking's category holds it. Fix is there for
 * full finance access. A purchase whose entries don't add up says why and is
 * left to a journal entry. A purchase the books hold under one category while
 * Banking showed another needs no one: the server shows it under the books'
 * category when it starts.
 */
export function CardCategoryFixes({
  company,
  drifts,
  accounts,
  homeCurrency,
  onFixed,
}: {
  company: Company;
  drifts: CardCategoryDrift[];
  accounts: Account[];
  homeCurrency: string;
  onFixed: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const canWrite = canWriteFinance(company);

  // The last one fixed closes the list; the notice goes with it.
  React.useEffect(() => {
    if (drifts.length === 0) setOpen(false);
  }, [drifts.length]);

  if (drifts.length === 0) return null;

  const label = (id: string | null) => {
    const account = accounts.find((item) => item.id === id);
    return account ? `${account.code} ${account.name}` : "an account that's gone";
  };
  const count = drifts.length;

  return (
    <>
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <div className="flex min-w-0 items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              {count === 1
                ? "1 card purchase doesn't match its category in your books"
                : `${count} card purchases don't match their category in your books`}
            </p>
            <p className="mt-0.5 text-amber-800 dark:text-amber-200/80">
              Entry review used to change card categories without telling Banking.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 self-start sm:self-auto"
          onClick={() => setOpen(true)}
        >
          Review
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Fix card categories"
        description="Fix posts one entry, dated today, so a purchase is filed only under the category Banking shows. It only moves amounts between expense categories, so your total expenses stay the same."
      >
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {drifts.map((drift) => (
            <DriftRow
              key={drift.transaction.id}
              company={company}
              drift={drift}
              label={label}
              money={(cents) => formatMoney(cents, homeCurrency)}
              canWrite={canWrite}
              onFixed={onFixed}
            />
          ))}
        </ul>
        <p className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {canWrite
            ? "Already corrected one with a journal entry? Leave it: fixing it here as well would correct it twice."
            : "Someone with full finance access can fix these."}
        </p>
      </Modal>
    </>
  );
}

function DriftRow({
  company,
  drift,
  label,
  money,
  canWrite,
  onFixed,
}: {
  company: Company;
  drift: CardCategoryDrift;
  label: (accountId: string | null) => string;
  money: (cents: number) => string;
  canWrite: boolean;
  onFixed: () => Promise<void>;
}) {
  const [fixing, setFixing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { transaction, repair } = drift;
  const banking = label(transaction.expenseAccountId);
  const signed = (cents: number) => (cents < 0 ? "−" : "") + money(Math.abs(cents));

  async function fix() {
    if (repair?.kind !== "reclassify") return;
    setFixing(true);
    setError(null);
    try {
      await api.post(
        `/api/companies/${company.id}/card-transactions/${transaction.id}/fix-category`,
        { lines: repair.lines },
      );
      await onFixed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't fix it"));
    } finally {
      setFixing(false);
    }
  }

  return (
    <li className="py-4 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {transaction.description || "Card transaction"}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {transactionDate(transaction.postedAt)} · {drift.feedName || "Card"}
            {transaction.accountingKind === "refund" ? " · refund" : ""}
          </p>
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
          {money(Math.abs(drift.bookedCents))}
        </span>
      </div>

      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Banking shows</dt>
          <dd className="mt-1 text-slate-800 dark:text-slate-100">{banking}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Your books have it under</dt>
          <dd className="mt-1">
            <ul className="space-y-0.5">
              {drift.filed.map((amount) => (
                <li key={amount.accountId} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">
                    {label(amount.accountId)}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-700 dark:text-slate-200">
                    {signed(amount.cents)}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>

      {repair?.kind === "reclassify" ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/40">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Fix posts this entry, dated today, so only {banking} holds it:
          </p>
          <table className="mt-2 w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-1 pr-2 text-left font-medium">Account</th>
                <th className="w-24 py-1 pl-2 text-right font-medium">Debit</th>
                <th className="w-24 py-1 pl-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {repair.lines.map((line) => (
                <tr
                  key={line.accountId}
                  className="border-t border-slate-200/70 dark:border-slate-700"
                >
                  <td className="py-1 pr-2 text-slate-700 dark:text-slate-200">
                    {label(line.accountId)}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {line.debitCents > 0 ? money(line.debitCents) : ""}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {line.creditCents > 0 ? money(line.creditCents) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {drift.problem}. Correct it with a journal entry.
        </p>
      )}

      <FormError message={error} className="mt-3" />
      {canWrite && repair?.kind === "reclassify" && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => void fix()} loading={fixing}>
            Fix
          </Button>
        </div>
      )}
    </li>
  );
}
