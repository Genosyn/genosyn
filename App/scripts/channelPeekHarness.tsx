/** Mount the production channel peek behind the same providers the app uses. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { ThemeProvider } from "@/components/Theme";
import { ChannelPeekModal } from "@/components/home/ChannelPeekModal";
import { DialogProvider } from "@/components/ui/Dialog";
import type { Company, HomeChannel, Me } from "@/lib/api";
import "../client/styles/index.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("case") ?? "short";
const instance = params.get("instance") ?? "default";
const longLabel = "#international-customer-success-release-coordination-and-search-visibility";
const label = scenario === "long-header" ? longLabel : "#release-coordination";

// Every document chooses explicitly so a dark-mode case cannot leak into the
// next page through this origin's persistent local storage.
localStorage.setItem("genosyn.theme", params.get("theme") === "dark" ? "dark" : "light");

const company = {
  id: "company",
  slug: "company",
  name: "Fixture Company",
  role: "member",
} as Company;
const me = {
  id: "member",
  name: "Morgan Lee",
  email: "morgan@example.test",
  handle: "@morgan",
} as Me;
const channel = {
  id: `${scenario}--${instance}`,
  kind: "public",
  label,
  unreadCount: scenario === "long" ? 5 : 1,
  lastReadAt: scenario === "long" ? "2026-09-16T09:24:00.000Z" : "2026-09-16T08:59:00.000Z",
} satisfies HomeChannel;

function Harness() {
  const route = useLocation();
  const [open, setOpen] = React.useState(false);
  const [closeCount, setCloseCount] = React.useState(0);
  const [readChannels, setReadChannels] = React.useState<string[]>([]);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="min-h-screen bg-slate-100 p-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    >
      <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold">Channel peek fixture</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          A quiet page behind the production modal.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white"
        >
          Open channel peek
        </button>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt>Current route</dt>
          <dd>
            <output aria-label="Current route">{route.pathname}</output>
          </dd>
          <dt>Modal closes</dt>
          <dd>
            <output aria-label="Modal closes">{closeCount}</output>
          </dd>
          <dt>Marked-read callbacks</dt>
          <dd>
            <output aria-label="Marked-read callbacks">{readChannels.length}</output>
          </dd>
        </dl>
      </div>

      {open ? (
        <ChannelPeekModal
          company={company}
          me={me}
          channel={channel}
          onClose={() => {
            setOpen(false);
            setCloseCount((count) => count + 1);
          }}
          onRead={(channelId) => setReadChannels((ids) => [...ids, channelId])}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/c/company"]}>
    <ThemeProvider>
      <DialogProvider>
        <Harness />
      </DialogProvider>
    </ThemeProvider>
  </MemoryRouter>,
);
