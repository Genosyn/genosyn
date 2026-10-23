import React from "react";

/**
 * The time, kept current, so "2 minutes ago" stays true while a page is open.
 * Re-renders the caller every `intervalMs`.
 */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
