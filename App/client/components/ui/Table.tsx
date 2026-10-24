import React from "react";
import { clsx } from "./clsx";

/**
 * Data tables. A card that scrolls sideways when the table is wider than the
 * screen (so a phone can still reach every column), sentence-case 12px column
 * headers, and rows with room to breathe.
 *
 *   <TableCard>
 *     <Table>
 *       <THead>
 *         <tr><TH>Name</TH><TH align="right">Total</TH></tr>
 *       </THead>
 *       <tbody>
 *         <TR><TD>…</TD><TD align="right" numeric>…</TD></TR>
 *       </tbody>
 *     </Table>
 *   </TableCard>
 */
export function TableCard({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={clsx(
        "overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    />
  );
}

export function Table({ className, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table {...rest} className={clsx("w-full text-sm", className)} />;
}

/** The header row group. Sentence case — the labels are written that way. */
export const theadClassName =
  "border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400";

export function THead({ className, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...rest} className={clsx(theadClassName, className)} />;
}

type Align = "left" | "right" | "center";
const ALIGN: Record<Align, string> = { left: "text-left", right: "text-right", center: "text-center" };

export function TH({
  align = "left",
  className,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
  return (
    <th
      scope="col"
      {...rest}
      className={clsx("whitespace-nowrap px-4 py-2.5 font-medium", ALIGN[align], className)}
    />
  );
}

export function TR({
  interactive = false,
  className,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement> & {
  /** The whole row opens something: give it the hover a link has. */
  interactive?: boolean;
}) {
  return (
    <tr
      {...rest}
      className={clsx(
        "border-b border-slate-100 last:border-b-0 dark:border-slate-800",
        interactive && "cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50",
        className,
      )}
    />
  );
}

export function TD({
  align = "left",
  numeric = false,
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  align?: Align;
  /** Money, counts, dates: tabular figures, so a column lines up. */
  numeric?: boolean;
}) {
  return (
    <td
      {...rest}
      className={clsx(
        "px-4 py-3 align-middle text-slate-700 dark:text-slate-200",
        ALIGN[align],
        numeric && "tabular-nums",
        className,
      )}
    />
  );
}
