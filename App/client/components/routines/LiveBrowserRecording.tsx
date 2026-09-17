import React from "react";
import { Loader2 } from "lucide-react";

const FRAME_INTERVAL_MS = 250;
const RETRY_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Show the recorder's existing frames without buffering another video. */
export function LiveBrowserRecording({ url }: { url: string }) {
  const [frameUrl, setFrameUrl] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"waiting" | "live" | "reconnecting">("waiting");

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let currentFrame: string | null = null;
    // Also retain any frame being decoded so cleanup can release it immediately.
    const frameUrls = new Set<string>();

    const releaseFrame = (frame: string) => {
      URL.revokeObjectURL(frame);
      frameUrls.delete(frame);
    };
    const clearFrame = () => {
      setFrameUrl(null);
      if (currentFrame) releaseFrame(currentFrame);
      currentFrame = null;
    };

    const poll = async () => {
      if (stopped || document.hidden) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let nextDelay = FRAME_INTERVAL_MS;
      let pendingFrame: string | null = null;
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (stopped || controller.signal.aborted) return;
        if (response.status === 204) {
          clearFrame();
          setState("waiting");
        } else {
          if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/jpeg")) {
            throw new Error("Live view unavailable");
          }
          const blob = await response.blob();
          if (stopped || controller.signal.aborted) return;
          pendingFrame = URL.createObjectURL(blob);
          frameUrls.add(pendingFrame);
          const image = new Image();
          image.src = pendingFrame;
          // Decode before replacing the displayed image to avoid flickering.
          await image.decode();
          if (stopped || controller.signal.aborted) return;
          const previousFrame = currentFrame;
          currentFrame = pendingFrame;
          pendingFrame = null;
          setFrameUrl(currentFrame);
          setState("live");
          if (previousFrame) releaseFrame(previousFrame);
        }
      } catch {
        if (stopped || document.hidden) return;
        // A revoked session or lost connection must not leave an old image
        // looking live. The Run log's normal poll handles terminal metadata.
        clearFrame();
        setState("reconnecting");
        nextDelay = RETRY_INTERVAL_MS;
      } finally {
        clearTimeout(timeout);
        if (pendingFrame) releaseFrame(pendingFrame);
        if (request === controller) request = undefined;
        if (!stopped && !document.hidden) timer = setTimeout(poll, nextDelay);
      }
    };

    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (document.hidden) {
        request?.abort();
        clearFrame();
        setState("waiting");
      } else if (!request) {
        void poll();
      }
    };

    setState("waiting");
    setFrameUrl(null);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const frame of frameUrls) URL.revokeObjectURL(frame);
      frameUrls.clear();
    };
  }, [url]);

  return frameUrl ? (
    <img
      src={frameUrl}
      alt="Live browser recording"
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  ) : (
    <div
      role="status"
      className="flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center text-slate-400"
    >
      <Loader2 size={24} className="animate-spin" />
      <div className="text-sm font-medium text-slate-200">
        {state === "reconnecting" ? "Reconnecting to live view…" : "Waiting for browser activity…"}
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        {state === "reconnecting"
          ? "The live view will retry automatically."
          : "The live view will appear when the browser sends its first frame."}
      </p>
    </div>
  );
}
