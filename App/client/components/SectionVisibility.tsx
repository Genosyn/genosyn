import React from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { activeSection } from "@/lib/sections";
import {
  readShowAllSections,
  writeShowAllSections,
  type SectionListing,
} from "@/lib/sectionVisibility";
import type { SubpageViewer } from "@/lib/subpages";
import type { UsedSectionsResponse } from "../../shared/navigation";

/**
 * Which sections browsing lists, for the ⌘K palette and the keyboard guide
 * alike (`lib/sectionVisibility.ts` holds the rule). It asks the server which
 * sections the company has started using once per company, and again each
 * time the palette opens, so a section joins the list the first time
 * something lands in it without anyone reloading.
 */

type SectionVisibilityState = {
  listing: SectionListing;
  setShowAll: (showAll: boolean) => void;
  /** Re-read which sections are in use; the palette calls it as it opens. */
  refresh: () => void;
};

const SectionVisibilityContext = React.createContext<SectionVisibilityState | null>(null);

export function SectionVisibilityProvider({
  companyId,
  viewer,
  children,
}: {
  companyId: string;
  viewer: SubpageViewer;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const [used, setUsed] = React.useState<ReadonlySet<string> | null>(null);
  const [showAll, setShowAllState] = React.useState(readShowAllSections);
  const latest = React.useRef(0);

  const refresh = React.useCallback(() => {
    const request = ++latest.current;
    api
      .get<UsedSectionsResponse>(`/api/companies/${companyId}/navigation/sections`)
      .then((body) => {
        if (request === latest.current) setUsed(new Set(body.used));
      })
      .catch(() => {
        // Keep what was known. Knowing nothing lists every section, which is
        // the safe way to be wrong.
      });
  }, [companyId]);

  React.useEffect(() => {
    setUsed(null);
    refresh();
  }, [refresh]);

  const setShowAll = React.useCallback((next: boolean) => {
    setShowAllState(next);
    writeShowAllSections(next);
  }, []);

  const current = activeSection(location.pathname);
  const value = React.useMemo<SectionVisibilityState>(
    () => ({ listing: { used, showAll, current, viewer }, setShowAll, refresh }),
    [used, showAll, current, viewer, setShowAll, refresh],
  );

  return (
    <SectionVisibilityContext.Provider value={value}>{children}</SectionVisibilityContext.Provider>
  );
}

export function useSectionVisibility(): SectionVisibilityState {
  const ctx = React.useContext(SectionVisibilityContext);
  if (!ctx) {
    throw new Error("useSectionVisibility must be used inside <SectionVisibilityProvider>");
  }
  return ctx;
}
