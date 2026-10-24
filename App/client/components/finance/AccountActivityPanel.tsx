import React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import {
  ACCOUNT_TYPE_LABEL,
  AccountActivityReport,
  AccountActivityRow,
  api,
  formatMoney,
} from "../../lib/api";
import {
  accountMeaning,
  addedAndTakenOff,
  debitAdds,
  formatBalance,
  formatChange,
  isUnusualBalance,
  ledgerDate,
  unusualBalanceNote,
} from "../../lib/ledgerAccounts";
import { ledgerSourceLabel } from "../../lib/ledgerSources";
import { useLiveRefetch } from "../CompanySocket";
import { Button } from "../ui/Button";
import { ModalCloseButton, useModalChrome } from "../ui/ModalChrome";
import { Spinner } from "../ui/Spinner";

/** Entries drawn at a time; a bank account's whole history can run to thousands. */
const PAGE = 100;

/**
 * Every entry behind one account's total, in plain words: what the account
 * holds, what added to it and what took away from it, and what was on the
 * other side of each entry — newest first, each with the balance it left.
 *
 * The Trial balance opens it on an account's whole history up to a date
 * (`from` null); Reports opens it on the period a report covers. A name on the
 * other side of an entry opens that account in place, with a way back, so the
 * money can be followed from one account to the next.
 */
export function AccountActivityPanel({
  companyId,
  homeCurrency,
  accountId,
  from,
  to,
  onClose,
}: {
  companyId: string;
  homeCurrency: string;
  accountId: string;
  /** First day, `YYYY-MM-DD`. Null reads the account from its first entry. */
  from: string | null;
  /** Last day, `YYYY-MM-DD`, inclusive. */
  to: string;
  onClose: () => void;
}) {
  const { titleId, panelRef } = useModalChrome({ open: true, onDismiss: onClose });
  const [currentId, setCurrentId] = React.useState(accountId);
  // The accounts followed to get here, for the way back.
  const [trail, setTrail] = React.useState<Array<{ id: string; name: string }>>([]);
  const [data, setData] = React.useState<AccountActivityReport | "error" | null>(null);
  const [shown, setShown] = React.useState(PAGE);
  const [retrying, setRetrying] = React.useState(false);

  // A reading panel has nothing to fill in, so the dialog itself takes focus
  // and its title is what a screen reader announces.
  React.useEffect(() => {
    panelRef.current?.focus();
  }, [panelRef]);

  const load = React.useCallback(async () => {
    const params = new URLSearchParams({ accountId: currentId, to });
    if (from) params.set("from", from);
    return api.get<AccountActivityReport>(
      `/api/companies/${companyId}/reports/account-activity?${params.toString()}`,
    );
  }, [companyId, currentId, from, to]);

  React.useEffect(() => {
    let alive = true;
    setData(null);
    setShown(PAGE);
    load()
      .then((report) => {
        if (alive) setData(report);
      })
      .catch(() => {
        if (alive) setData("error");
      });
    return () => {
      alive = false;
    };
  }, [load]);

  // A change to the books refreshes what is on screen, unless the reader has
  // moved to another account by the time it lands.
  const currentRef = React.useRef(currentId);
  currentRef.current = currentId;
  const refresh = React.useCallback(() => {
    load()
      .then((report) => {
        if (report.account.id === currentRef.current) setData(report);
      })
      .catch(() => undefined);
  }, [load]);
  useLiveRefetch("ledger", refresh);

  async function retry() {
    setRetrying(true);
    try {
      setData(await load());
    } catch {
      setData("error");
    } finally {
      setRetrying(false);
    }
  }

  // Moving to another account replaces the button that was pressed, so focus
  // goes back to the dialog rather than falling out of it.
  function follow(next: { id: string }) {
    if (!data || data === "error") return;
    setTrail((t) => [...t, { id: data.account.id, name: data.account.name }]);
    setCurrentId(next.id);
    panelRef.current?.focus();
  }

  function back() {
    const previous = trail[trail.length - 1];
    if (!previous) return;
    setTrail((t) => t.slice(0, -1));
    setCurrentId(previous.id);
    panelRef.current?.focus();
  }

  const report = data && data !== "error" ? data : null;
  const previous = trail[trail.length - 1];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-scrim-in justify-end bg-slate-900/35 motion-reduce:animate-none dark:bg-slate-950/80"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            {previous && (
              <button
                type="button"
                onClick={back}
                className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                <ArrowLeft size={12} /> Back to {previous.name}
              </button>
            )}
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {report ? (
                <>
                  {ACCOUNT_TYPE_LABEL[report.account.type]} ·{" "}
                  <span className="font-mono">{report.account.code}</span>
                </>
              ) : (
                "Account"
              )}
            </div>
            <h2
              id={titleId}
              className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              {report ? report.account.name : data === "error" ? "Account entries" : "Loading…"}
            </h2>
            {report && accountMeaning(report.account) && (
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {accountMeaning(report.account)}
              </p>
            )}
          </div>
          <ModalCloseButton onClick={onClose} />
        </div>

        {data === null ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : data === "error" ? (
          <div className="p-6">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Couldn&apos;t load this account&apos;s entries.
            </p>
            <Button variant="secondary" className="mt-3" loading={retrying} onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <ActivitySummary report={data} from={from} to={to} homeCurrency={homeCurrency} />
            <ActivityRows
              report={data}
              from={from}
              shown={shown}
              homeCurrency={homeCurrency}
              onFollow={follow}
              onShowMore={() => setShown((n) => n + PAGE)}
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ActivitySummary({
  report,
  from,
  to,
  homeCurrency,
}: {
  report: AccountActivityReport;
  from: string | null;
  to: string;
  homeCurrency: string;
}) {
  const { account, rows } = report;
  const debits = rows.reduce((sum, r) => sum + r.debitCents, 0);
  const credits = rows.reduce((sum, r) => sum + r.creditCents, 0);
  const { addedCents, takenOffCents } = addedAndTakenOff(account.type, debits, credits);
  const entries = `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`;
  // Only a whole history explains a balance: a period's rows leave out what
  // came before it.
  const unusual = from === null && isUnusualBalance(account, report.closingBalance);

  return (
    <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
      {from === null ? (
        <>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Balance on {ledgerDate(to)}
          </div>
          <div
            className={
              "mt-0.5 text-2xl font-semibold tabular-nums " +
              (unusual
                ? "text-amber-700 dark:text-amber-400"
                : "text-slate-900 dark:text-slate-100")
            }
          >
            {formatBalance(report.closingBalance, homeCurrency)}
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {formatMoney(addedCents, homeCurrency)} added ·{" "}
            {formatMoney(takenOffCents, homeCurrency)} taken off · {entries}
          </div>
        </>
      ) : (
        <>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Change from {ledgerDate(from)} to {ledgerDate(to)}
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatChange(report.closingBalance - report.openingBalance, homeCurrency)}
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {formatBalance(report.openingBalance, homeCurrency)} at the start →{" "}
            {formatBalance(report.closingBalance, homeCurrency)} at the end · {entries}
          </div>
        </>
      )}
      {unusual && (
        <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Below zero, which is unusual for this account.{" "}
            {unusualBalanceNote(account, debits, credits, (c) => formatMoney(c, homeCurrency))}
          </span>
        </p>
      )}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {debitAdds(account.type)
          ? "For this account a debit adds and a credit takes off."
          : "For this account a credit adds and a debit takes off."}{" "}
        The other side of each entry is the account the money came from or went to.
      </p>
    </div>
  );
}

function ActivityRows({
  report,
  from,
  shown,
  homeCurrency,
  onFollow,
  onShowMore,
}: {
  report: AccountActivityReport;
  from: string | null;
  shown: number;
  homeCurrency: string;
  onFollow: (account: { id: string }) => void;
  onShowMore: () => void;
}) {
  const newestFirst = React.useMemo(() => [...report.rows].reverse(), [report.rows]);
  if (newestFirst.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
        {from === null
          ? "Nothing has been posted to this account yet."
          : "No entries in this period."}
      </div>
    );
  }
  const visible = newestFirst.slice(0, shown);
  const hidden = newestFirst.length - visible.length;
  return (
    <>
      <div className="flex items-center justify-between bg-slate-50 px-5 py-2 text-xs font-medium text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
        <span>Entries, newest first</span>
        <span>Change · balance after</span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {visible.map((row, i) => (
          <ActivityRow
            key={`${row.entryId}-${i}`}
            row={row}
            type={report.account.type}
            homeCurrency={homeCurrency}
            onFollow={onFollow}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <div className="border-t border-slate-100 px-5 py-3 text-center dark:border-slate-800">
          <Button variant="secondary" size="sm" onClick={onShowMore}>
            Show {Math.min(hidden, PAGE)} older {hidden === 1 ? "entry" : "entries"}
          </Button>
          <div className="mt-1 text-xs text-slate-400">{hidden} not shown</div>
        </div>
      ) : (
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-800/40">
          <span className="text-slate-500 dark:text-slate-400">
            {from === null ? "Started at" : `Balance on ${ledgerDate(from)}`}
          </span>
          <span className="tabular-nums text-slate-700 dark:text-slate-200">
            {formatBalance(report.openingBalance, homeCurrency)}
          </span>
        </div>
      )}
    </>
  );
}

function ActivityRow({
  row,
  type,
  homeCurrency,
  onFollow,
}: {
  row: AccountActivityRow;
  type: AccountActivityReport["account"]["type"];
  homeCurrency: string;
  onFollow: (account: { id: string }) => void;
}) {
  const { addedCents, takenOffCents } = addedAndTakenOff(type, row.debitCents, row.creditCents);
  const title = row.memo || row.description;
  const others = row.otherAccounts;
  return (
    <li className="flex items-start justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="text-sm text-slate-900 dark:text-slate-100">
          {title || <span className="text-slate-400">No description</span>}
        </div>
        {row.memo && row.description && row.description !== row.memo && (
          <div className="text-xs text-slate-500 dark:text-slate-400">{row.description}</div>
        )}
        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {ledgerDate(row.date)} · {ledgerSourceLabel(row.source, row.sourceRefId)}
        </div>
        {others.length > 0 && (
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Other side:{" "}
            {others.slice(0, 3).map((other, i) => (
              <React.Fragment key={other.id}>
                {i > 0 && ", "}
                <button
                  type="button"
                  onClick={() => onFollow(other)}
                  title={`Open ${other.code} ${other.name}`}
                  className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {other.name}
                </button>
              </React.Fragment>
            ))}
            {others.length > 3 && ` and ${others.length - 3} more`}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div
          className="text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100"
          title={
            row.debitCents > 0
              ? `Debit ${formatMoney(row.debitCents, homeCurrency)}`
              : `Credit ${formatMoney(row.creditCents, homeCurrency)}`
          }
        >
          {formatChange(addedCents - takenOffCents, homeCurrency)}
        </div>
        <div className="text-xs tabular-nums text-slate-400">
          {formatBalance(row.runningBalanceCents, homeCurrency)}
        </div>
      </div>
    </li>
  );
}
