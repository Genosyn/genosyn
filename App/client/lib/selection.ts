/**
 * Ticking rows in a list for a bulk bar: the Decision stack's and Banking's.
 */

/**
 * Tick or untick `key`. With `extend` (a shift-click) the whole run from
 * `anchor`, the last row ticked, takes the clicked row's new state — in
 * `order`, the order the rows are on screen.
 */
export function toggleSelection(
  current: ReadonlySet<string>,
  order: readonly string[],
  key: string,
  anchor: string | null,
  extend: boolean,
): Set<string> {
  const next = new Set(current);
  const index = order.indexOf(key);
  const from = anchor ? order.indexOf(anchor) : -1;
  if (extend && index >= 0 && from >= 0) {
    const select = !current.has(key);
    const [start, end] = from < index ? [from, index] : [index, from];
    for (let i = start; i <= end; i += 1) {
      if (select) next.add(order[i]);
      else next.delete(order[i]);
    }
  } else if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/** Split a selection into requests the server takes at once. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
