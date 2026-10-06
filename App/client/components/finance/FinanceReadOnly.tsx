import { Link } from "react-router-dom";
import type { Company } from "@/lib/api";
import { effectiveFinanceAccess } from "@/lib/subpages";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { clsx } from "@/components/ui/clsx";

/**
 * What a Member with read-only Finance access sees where a page would
 * otherwise let them change something (`canWriteFinance`) — in Finance, and
 * in Customers, whose accounts the finance routes write. Most controls are
 * simply left out; these two explain the places where leaving them out alone
 * would read as broken.
 */

/**
 * Beside fields shown disabled or read-only — settings, templates, a vendor's
 * details — so a form that won't take input says why.
 */
export function FinanceReadOnlyNote({ className }: { className?: string }) {
  return (
    <p
      className={clsx(
        "rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400",
        className,
      )}
    >
      You have read-only access to Finance, so you can view this but not change it. Owners and
      admins choose each Member&apos;s finance access under Settings → Members.
    </p>
  );
}

const FINANCE = { label: "Finance", path: "finance" };

const ASK_FOR_ACCESS =
  "Owners and admins choose each Member's finance access. Ask one of them to change yours under Settings → Members.";

/**
 * In place of a create or edit form, for a read-only Member who arrives on
 * one anyway — a saved link, a pasted URL, the browser's history. The form's
 * submit could only be refused, so they get its breadcrumb trail and a way
 * back instead of fields that pretend otherwise.
 *
 * Customers' forms use it too. That section stays open to a Member with no
 * finance access at all, for its Contracts, so one can land here as well, and
 * is told they have no access rather than read-only access.
 */
export function FinanceReadOnlyPage({
  company,
  section = FINANCE,
  list,
  title,
  backTo,
}: {
  company: Company;
  /** The section the form is in, as its breadcrumb reads: Finance unless given. */
  section?: { label: string; path: string };
  /**
   * The list the form belongs to, as its breadcrumb reads: "Invoices" at
   * `invoices`. Left out where the section's own page is that list, as
   * Customers' is.
   */
  list?: { label: string; path: string };
  /** The form's own heading: "New invoice", "Edit schedule". */
  title: string;
  /**
   * Where Back goes, under the section: the record being edited, or the list
   * ("" for the section's own page).
   */
  backTo: string;
}) {
  const root = `/c/${company.slug}/${section.path}`;
  const records = (list ?? section).label.toLowerCase();
  const noAccess = effectiveFinanceAccess(company) === "none";
  return (
    <div className="page-shell p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: section.label, to: root },
            ...(list ? [{ label: list.label, to: `${root}/${list.path}` }] : []),
            { label: title },
          ]}
        />
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
      <EmptyState
        title={
          noAccess ? "You don't have access to Finance" : "You have read-only access to Finance"
        }
        description={
          noAccess
            ? ASK_FOR_ACCESS
            : `You can view ${records} but not create or edit them. ${ASK_FOR_ACCESS}`
        }
        action={
          <Link to={backTo ? `${root}/${backTo}` : root}>
            <Button variant="secondary">Back</Button>
          </Link>
        }
      />
    </div>
  );
}
