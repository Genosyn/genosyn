/** The real Run recording pane; browser checks provide deterministic HTTP responses. */
import React from "react";
import { createRoot } from "react-dom/client";
import { RunBrowserRecordingsPane } from "@/components/routines/RunViews";
import type { RunBrowserRecording } from "@/lib/api";
import "../client/styles/index.css";

const params = new URLSearchParams(location.search);
const recording: RunBrowserRecording = {
  id: "session-a",
  status: "recording",
  startedAt: "2026-09-17T10:00:00.000Z",
  finishedAt: null,
  mimeType: null,
  sizeBytes: null,
  filename: null,
};

function Harness() {
  const [mounted, setMounted] = React.useState(true);
  const [recordings, setRecordings] = React.useState<RunBrowserRecording[]>(
    params.has("multiple") ? [recording, { ...recording, id: "session-b" }] : [recording],
  );
  const updateStatus = (status: "finalizing" | "ready") => {
    const mimeType = params.get("videoMime") ?? "video/mp4";
    setRecordings((current) =>
      current.map((item) => ({
        ...item,
        status,
        finishedAt: "2026-09-17T10:01:12.000Z",
        ...(status === "ready"
          ? {
              mimeType,
              filename: `${item.id}.${mimeType.includes("mp4") ? "mp4" : "webm"}`,
              sizeBytes: 24_000,
            }
          : {}),
      })),
    );
  };
  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h1 className="mb-4 text-lg font-semibold text-slate-900">Run: Daily company briefing</h1>
        {mounted && (
          <RunBrowserRecordingsPane companyId="company" runId="run" recordings={recordings} />
        )}
        <section
          aria-label="Test fixture controls"
          className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500"
        >
          <button onClick={() => updateStatus("finalizing")}>Finalize recording</button>
          <button onClick={() => updateStatus("ready")}>Save recording</button>
          <button onClick={() => setMounted((current) => !current)}>
            {mounted ? "Unmount recording" : "Mount recording"}
          </button>
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
