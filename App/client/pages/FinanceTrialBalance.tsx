import React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, CheckCircle2, ChevronRight, Download } from "lucide-react";
import {
  api,
  CompanyFinanceSettings,
  formatMoney,
  TrialBalanceResponse,
  TrialBalanceRow,
} from "../lib/api";
import {
  ACCOUNT_TYPE_MEANING,
  ACCOUNT_TYPE_PLURAL,
  accountMeaning,
  debitAdds,
  formatBalance,
  hasPostings,
  isUnusualBalance,
  ledgerDate,
  summarizeTrialBalance,
  TrialBalanceSummary,
  unusualBalanceNote,
} from "../lib/ledgerAccounts";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { AccountActivityPanel } from "../components/finance/AccountActivityPanel";
import { Button } from "../components/ui/Button";
import { Disclosure } from "../components/ui/Disclosure";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The day `?asOf=` names, when it names a real one. */
function dayParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * Trial balance: every account's total on one date, and the check that the
 * books add up — every debit has a matching credit, so the Debits and Credits
 * columns total the same.
 *
 * Written for the person running the company as much as for their
 * accountant. It leads with the verdict in plain words and the same check
 * restated as owns = owes + the owners' stake + profit so far, says what each
 * group and system account holds, flags a balance below zero with what
 * usually causes it, and opens any account on the entries behind its total
 * (`AccountActivityPanel`). Accounts nothing was posted to stay tucked away
 * until asked for.
 *
 * `?asOf=` and `?account=` keep the date and the open account in the address,
 * so a link can open the page on either.
 */
export default function FinanceTrialBalance() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [searchParams, setSearchParams] = useSearchParams();
  const asOf = dayParam(searchParams.get("asOf")) ?? today();
  const openAccountId = searchParams.get("account");
  const [data, setData] = React.useState<TrialBalanceResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [homeCurrency, setHomeCurrency] = React.useState("USD");
  const [showEmpty, setShowEmpty] = React.useState(false);

  const setParam = React.useCallback(
    (key: "asOf" | "account", value: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Only the latest request lands, so a quick run of date changes can't
  // leave an older day's totals on screen.
  const latest = React.useRef(0);
  const reload = React.useCallback(async () => {
    const request = ++latest.current;
    try {
      const report = await api.get<TrialBalanceResponse>(
        `/api/companies/${company.id}/ledger/trial-balance?asOf=${encodeURIComponent(
          new Date(`${asOf}T00:00:00Z`).toISOString(),
        )}`,
      );
      if (request !== latest.current) return;
      setData(report);
      setLoadError(null);
    } catch (err) {
      if (request === latest.current) setLoadError((err as Error).message);
    }
  }, [company.id, asOf]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefetch(["ledger", "financeaccount"], () => void reload());

  React.useEffect(() => {
    let alive = true;
    api
      .get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`)
      .then((settings) => {
        if (alive) setHomeCurrency(settings.homeCurrency);
      })
      .catch(() => {
        if (alive) setHomeCurrency("USD");
      });
    return () => {
      alive = false;
    };
  }, [company.id]);

  async function retry() {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }

  const summary = React.useMemo(() => (data ? summarizeTrialBalance(data.rows) : null), [data]);
  const nothingPosted = !!data && summary?.emptyCount === data.rows.length;
  const openAccount = (accountId: string) => setParam("account", accountId);

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Trial balance" },
          ]}
        />
      </div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Trial balance
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            A health check for your books: what every account holds on one date, and proof that it
            all adds up. Click any account to see the entries behind its total.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <Input
              label="As of"
              type="date"
              value={asOf}
              onChange={(e) => {
                const day = dayParam(e.target.value);
                if (day) setParam("asOf", day);
              }}
            />
          </div>
          <a
            href={`/api/companies/${company.id}/exports/trial-balance.csv?asOf=${encodeURIComponent(
              new Date(`${asOf}T00:00:00Z`).toISOString(),
            )}`}
            download
            title="Download this trial balance as a CSV for your accountant"
          >
            <Button variant="secondary">
              <Download size={14} /> CSV
            </Button>
          </a>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          <p>Couldn&apos;t load the trial balance: {loadError}</p>
          <Button variant="secondary" size="sm" className="mt-3" loading={retrying} onClick={retry}>
            Try again
          </Button>
        </div>
      ) : summary === null || data === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <div className="space-y-4">
          {nothingPosted ? (
            <EmptyState
              title="Nothing in your books yet"
              description="Issue an invoice, record a bill, or categorize a bank transaction, and every account's total shows up here — with a check that it all adds up."
            />
          ) : (
            <>
              <BooksCheck summary={summary} asOf={data.asOf} homeCurrency={homeCurrency} />
              {summary.unusual.length > 0 && (
                <WorthALook
                  rows={summary.unusual}
                  homeCurrency={homeCurrency}
                  onOpen={openAccount}
                />
              )}
              <HowToRead companySlug={company.slug} homeCurrency={homeCurrency} />
            </>
          )}
          {(!nothingPosted || showEmpty) && (
            <BalancesTable
              summary={summary}
              showEmpty={showEmpty}
              homeCurrency={homeCurrency}
              onOpen={openAccount}
            />
          )}
          {summary.emptyCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEmpty((shown) => !shown)}
              className="text-sm text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
            >
              {showEmpty
                ? "Hide accounts with nothing posted"
                : `Show ${summary.emptyCount} ${
                    summary.emptyCount === 1 ? "account" : "accounts"
                  } with nothing posted yet`}
            </button>
          )}
        </div>
      )}

      {openAccountId && (
        <AccountActivityPanel
          key={`${openAccountId}:${asOf}`}
          companyId={company.id}
          homeCurrency={homeCurrency}
          accountId={openAccountId}
          from={null}
          to={asOf}
          onClose={() => setParam("account", null)}
        />
      )}
    </div>
  );
}

/** The verdict, then the same check as what the company owns, owes, and has made. */
function BooksCheck({
  summary,
  asOf,
  homeCurrency,
}: {
  summary: TrialBalanceSummary;
  asOf: string;
  homeCurrency: string;
}) {
  const money = (cents: number) => formatMoney(cents, homeCurrency);
  const balanced = summary.debitCents === summary.creditCents;
  const profit = summary.incomeCents - summary.expensesCents;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        {balanced ? (
          <CheckCircle2
            size={22}
            className="mt-0.5 shrink-0 text-emerald-500 dark:text-emerald-400"
            aria-hidden="true"
          />
        ) : (
          <AlertTriangle
            size={22}
            className="mt-0.5 shrink-0 text-amber-500 dark:text-amber-400"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {balanced
              ? "Your books add up"
              : `Your books are off by ${money(Math.abs(summary.debitCents - summary.creditCents))}`}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {balanced ? (
              <>
                Every debit has a matching credit — both sides total{" "}
                <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                  {money(summary.debitCents)}
                </span>{" "}
                on {ledgerDate(asOf)} — so nothing was recorded on one side only.
              </>
            ) : (
              <>
                Debits total {money(summary.debitCents)} but credits total{" "}
                {money(summary.creditCents)}. Every transaction is recorded as a debit and a
                matching credit, so an entry is probably missing one side. Your accountant can find
                it in Journal entries.
              </>
            )}
          </p>
        </div>
      </div>
      {/* One line reads as the equation it is once there is room for it; until
          then the tiles sit two by two and a caption says how they relate. */}
      <div className="mt-5 grid grid-cols-2 gap-2 sm:gap-3 xl:flex xl:items-stretch xl:gap-2">
        <SummaryTile
          label="You own"
          caption="Assets"
          cents={summary.ownCents}
          homeCurrency={homeCurrency}
        />
        <Operator>{balanced ? "=" : "≠"}</Operator>
        <SummaryTile
          label="You owe"
          caption="Liabilities"
          cents={summary.oweCents}
          homeCurrency={homeCurrency}
        />
        <Operator>+</Operator>
        <SummaryTile
          label="Owners' stake"
          caption="Equity"
          cents={summary.stakeCents}
          homeCurrency={homeCurrency}
        />
        <Operator>+</Operator>
        <SummaryTile
          label="Profit so far"
          caption={`Income ${money(summary.incomeCents)} − expenses ${money(summary.expensesCents)}`}
          cents={profit}
          homeCurrency={homeCurrency}
        />
      </div>
      <p className="mt-3 text-xs text-slate-500 xl:hidden dark:text-slate-400">
        {balanced
          ? "What you own = what you owe + the owners' stake + profit so far."
          : "What you own should equal what you owe + the owners' stake + profit so far."}
      </p>
    </section>
  );
}

function SummaryTile({
  label,
  caption,
  cents,
  homeCurrency,
}: {
  label: string;
  caption: string;
  cents: number;
  homeCurrency: string;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2.5 sm:px-3.5 sm:py-3 xl:flex-1 dark:bg-slate-800/60">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className="mt-0.5 truncate text-base font-semibold tabular-nums text-slate-900 sm:text-lg dark:text-slate-100"
        title={formatBalance(cents, homeCurrency)}
      >
        {formatBalance(cents, homeCurrency)}
      </div>
      <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{caption}</div>
    </div>
  );
}

function Operator({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="hidden items-center px-0.5 text-lg font-medium text-slate-400 xl:flex dark:text-slate-500"
    >
      {children}
    </div>
  );
}

/** Balances below zero, each with what put it there and a way into its entries. */
function WorthALook({
  rows,
  homeCurrency,
  onOpen,
}: {
  rows: TrialBalanceRow[];
  homeCurrency: string;
  onOpen: (accountId: string) => void;
}) {
  const money = (cents: number) => formatMoney(cents, homeCurrency);
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <AlertTriangle size={16} aria-hidden="true" />
        {rows.length === 1
          ? "One account is worth a look"
          : `${rows.length} accounts are worth a look`}
      </h2>
      <ul className="mt-2 space-y-2.5">
        {rows.map((row) => (
          <li
            key={row.account.id}
            className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
          >
            <p className="text-sm text-amber-900 dark:text-amber-100">
              <span className="font-semibold">{row.account.name}</span> is below zero at{" "}
              <span className="font-semibold tabular-nums">
                {formatBalance(row.balanceCents, homeCurrency)}
              </span>
              . {unusualBalanceNote(row.account, row.debitCents, row.creditCents, money)}
            </p>
            <button
              type="button"
              onClick={() => onOpen(row.account.id)}
              className="inline-flex shrink-0 items-center gap-0.5 self-start whitespace-nowrap text-sm font-medium text-amber-800 hover:underline dark:text-amber-200"
            >
              See entries <ChevronRight size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HowToRead({ companySlug, homeCurrency }: { companySlug: string; homeCurrency: string }) {
  const hundred = formatMoney(10000, homeCurrency);
  return (
    <Disclosure
      variant="card"
      title="How to read a trial balance"
      summary="Debits, credits, and what this page checks"
    >
      <div className="max-w-3xl space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        <p>
          <strong className="text-slate-900 dark:text-slate-100">Accounts</strong> are the buckets
          everything in your books is sorted into: what the company owns (assets), what it owes
          (liabilities), what the owners put in and kept (equity), what it earns (income), and what
          it spends (expenses).
        </p>
        <p>
          <strong className="text-slate-900 dark:text-slate-100">Debits and credits</strong> are the
          two halves of every transaction. Paying a {hundred} software bill from the bank records a{" "}
          {hundred} debit to General &amp; Administrative — you spent more — and a {hundred} credit
          to Bank — you have less. A debit adds to what you own and spend; a credit adds to what you
          owe, what you earn, and the owners&apos; stake.
        </p>
        <p>
          <strong className="text-slate-900 dark:text-slate-100">The check.</strong> Because every
          transaction has both halves, the Debits and Credits columns always total the same. Put
          another way: what the company owns equals what it owes, plus the owners&apos; stake, plus
          profit so far. If that ever fails, an entry was recorded with one half missing.
        </p>
        <p>
          <strong className="text-slate-900 dark:text-slate-100">Balance</strong> is what each
          account holds on the date you picked. Below zero is unusual for most accounts, so it is
          flagged. Profit so far counts every period you haven&apos;t closed; closing one on{" "}
          <Link
            to={`/c/${companySlug}/finance/periods`}
            className="text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Periods &amp; exports
          </Link>{" "}
          moves its profit into Retained Earnings.
        </p>
        <p>Click any account to see each entry behind its total, and what was on its other side.</p>
      </div>
    </Disclosure>
  );
}

function BalancesTable({
  summary,
  showEmpty,
  homeCurrency,
  onOpen,
}: {
  summary: TrialBalanceSummary;
  showEmpty: boolean;
  homeCurrency: string;
  onOpen: (accountId: string) => void;
}) {
  const balanced = summary.debitCents === summary.creditCents;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-4 py-2 text-left font-medium">
              Account
            </th>
            <th
              scope="col"
              className="hidden w-36 px-4 py-2 text-right font-medium sm:table-cell"
              title="Every debit posted to the account up to the date"
            >
              Debits
            </th>
            <th
              scope="col"
              className="hidden w-36 px-4 py-2 text-right font-medium sm:table-cell"
              title="Every credit posted to the account up to the date"
            >
              Credits
            </th>
            <th
              scope="col"
              className="w-28 px-4 py-2 text-right font-medium sm:w-36"
              title="What the account holds on the date"
            >
              Balance
            </th>
            <th scope="col" className="w-9">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {summary.groups.map((group) => {
            const rows = showEmpty ? group.rows : group.rows.filter(hasPostings);
            if (rows.length === 0) return null;
            const adds = debitAdds(group.type);
            const plural = ACCOUNT_TYPE_PLURAL[group.type].toLowerCase();
            return (
              <React.Fragment key={group.type}>
                <tr className="border-t border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-800/40">
                  <th scope="rowgroup" className="px-4 py-2 text-left font-normal">
                    <span className="text-xs font-medium mr-2 text-slate-700 dark:text-slate-200">
                      {ACCOUNT_TYPE_PLURAL[group.type]}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {ACCOUNT_TYPE_MEANING[group.type]}
                    </span>
                  </th>
                  <td
                    className="hidden px-4 py-2 text-right text-[11px] text-slate-400 sm:table-cell dark:text-slate-500"
                    title={`A debit ${adds ? "adds to" : "takes off"} ${plural}`}
                  >
                    {adds ? "adds" : "takes off"}
                  </td>
                  <td
                    className="hidden px-4 py-2 text-right text-[11px] text-slate-400 sm:table-cell dark:text-slate-500"
                    title={`A credit ${adds ? "takes off" : "adds to"} ${plural}`}
                  >
                    {adds ? "takes off" : "adds"}
                  </td>
                  <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-300">
                    {formatBalance(group.totalCents, homeCurrency)}
                  </td>
                  <td />
                </tr>
                {rows.map((row) => (
                  <AccountRow
                    key={row.account.id}
                    row={row}
                    homeCurrency={homeCurrency}
                    onOpen={onOpen}
                  />
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60">
            <th
              scope="row"
              className="px-4 py-3 text-left text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              Total
            </th>
            <td className="hidden px-4 py-3 text-right font-semibold tabular-nums text-slate-900 sm:table-cell dark:text-slate-100">
              {formatMoney(summary.debitCents, homeCurrency)}
            </td>
            <td className="hidden px-4 py-3 text-right font-semibold tabular-nums text-slate-900 sm:table-cell dark:text-slate-100">
              {formatMoney(summary.creditCents, homeCurrency)}
            </td>
            <td className="px-4 py-3 text-right">
              {balanced ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                  <Check size={12} aria-hidden="true" /> Adds up
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  Off by{" "}
                  {formatMoney(Math.abs(summary.debitCents - summary.creditCents), homeCurrency)}
                </span>
              )}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AccountRow({
  row,
  homeCurrency,
  onOpen,
}: {
  row: TrialBalanceRow;
  homeCurrency: string;
  onOpen: (accountId: string) => void;
}) {
  const meaning = accountMeaning(row.account);
  const posted = hasPostings(row);
  const unusual = isUnusualBalance(row.account, row.balanceCents);
  const open = () => onOpen(row.account.id);
  return (
    <tr
      onClick={open}
      className="group cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
    >
      <td className="px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="hidden min-w-[2.75rem] shrink-0 font-mono text-xs text-slate-400 sm:block dark:text-slate-500">
            {row.account.code}
          </span>
          <div className="min-w-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
              className="text-left font-medium text-slate-900 group-hover:text-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-100 dark:group-hover:text-indigo-300"
            >
              {row.account.name}
            </button>
            {meaning && <div className="text-xs text-slate-500 dark:text-slate-400">{meaning}</div>}
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-2.5 text-right tabular-nums text-slate-500 sm:table-cell dark:text-slate-400">
        {row.debitCents > 0 ? formatMoney(row.debitCents, homeCurrency) : "—"}
      </td>
      <td className="hidden px-4 py-2.5 text-right tabular-nums text-slate-500 sm:table-cell dark:text-slate-400">
        {row.creditCents > 0 ? formatMoney(row.creditCents, homeCurrency) : "—"}
      </td>
      <td
        className={
          "px-4 py-2.5 text-right font-semibold tabular-nums " +
          (unusual
            ? "text-amber-700 dark:text-amber-400"
            : posted
              ? "text-slate-900 dark:text-slate-100"
              : "font-normal text-slate-400 dark:text-slate-500")
        }
      >
        <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
          {unusual && <AlertTriangle size={13} aria-label="Below zero" />}
          {posted ? formatBalance(row.balanceCents, homeCurrency) : "—"}
        </span>
      </td>
      <td className="pr-3 text-slate-300 group-hover:text-slate-500 dark:text-slate-600 dark:group-hover:text-slate-400">
        <ChevronRight size={16} aria-hidden="true" />
      </td>
    </tr>
  );
}
