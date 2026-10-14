import React from "react";

/**
 * The time zone the schedules beneath it are read in.
 *
 * A Routine's cron fields are wall-clock numbers read in its company's time
 * zone (Settings → Company), so the schedule picker has to preview and label
 * them there. The picker is also used by Pipelines and Revenue Signals, which
 * keep reading the server's own clock — so the zone is not a property of the
 * picker but of the part of the app it sits in. The Routines section wraps its
 * pages in this; everything else has no provider, which means *server time and
 * nothing to configure*, and previews exactly as it always did.
 *
 * `ScheduleField`'s own `timeZone` prop wins over this when it is given.
 */
const ScheduleTimeZoneContext = React.createContext<string | null>(null);

export function ScheduleTimeZone({
  timeZone,
  children,
}: {
  /** An IANA name (`Europe/Berlin`), or empty / missing for server time. */
  timeZone: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <ScheduleTimeZoneContext.Provider value={timeZone ?? ""}>
      {children}
    </ScheduleTimeZoneContext.Provider>
  );
}

/**
 * The zone schedules are read in here: an IANA name, the empty string for
 * server time that the company can change, or null outside any
 * {@link ScheduleTimeZone} — server time that no company setting reaches.
 */
export function useScheduleTimeZone(): string | null {
  return React.useContext(ScheduleTimeZoneContext);
}
