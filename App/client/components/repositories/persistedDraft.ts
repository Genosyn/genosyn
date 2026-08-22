import React from "react";

/** Keep an unfinished brief through navigation and accidental refreshes. */
export function usePersistedDraft(
  storageKey: string,
): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [value, setValue] = React.useState(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });

  React.useEffect(() => {
    try {
      if (value) window.localStorage.setItem(storageKey, value);
      else window.localStorage.removeItem(storageKey);
    } catch {
      // A blocked storage API should never block someone from delegating work.
    }
  }, [storageKey, value]);

  return [value, setValue];
}
