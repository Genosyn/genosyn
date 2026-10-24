import { clsx } from "./clsx";

/**
 * A placeholder block in the shape of what is loading, so the page keeps its
 * layout instead of jumping when the data lands. Size it with utilities:
 * `<Skeleton className="h-4 w-40" />`. Hidden from screen readers — pair a
 * loading region with `aria-busy` on its container.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        "animate-pulse rounded-md bg-slate-200/70 motion-reduce:animate-none dark:bg-slate-800",
        className,
      )}
    />
  );
}

/**
 * Rows of a list that has not loaded yet: a title line and a shorter meta line
 * per row, inside the same card a loaded list uses.
 */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        "divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={clsx("h-3.5", index % 2 ? "w-1/3" : "w-2/5")} />
            <Skeleton className={clsx("h-3", index % 2 ? "w-1/4" : "w-1/5")} />
          </div>
          <Skeleton className="hidden h-5 w-16 sm:block" />
        </div>
      ))}
    </div>
  );
}
