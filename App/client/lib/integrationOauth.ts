import { api } from "@/lib/api";

export type IntegrationOauthStart = {
  authorizeUrl: string;
  hostedAttempt?: string;
  hostedBrowserProof?: string;
  expiresAt?: number;
};

/** Open during the click, before any network request can lose the popup gesture. */
export function connectWithOauth(args: {
  companyId: string;
  start: () => Promise<IntegrationOauthStart>;
  signal: AbortSignal;
  onWaiting?: () => void;
}): Promise<void> {
  if (args.signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  // A fresh unnamed window also works on HTTP LAN installs, where secure-
  // context APIs such as crypto.randomUUID are unavailable.
  const popup = window.open("about:blank", "_blank", "width=520,height=700");
  if (!popup)
    return Promise.reject(new Error("Popup blocked — allow popups for this site and try again."));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let directReady = false;
    let hostedAttempt: string | undefined;
    let hostedBrowserProof: string | undefined;
    let hostedOrigin: string | undefined;
    let hostedRequestId: string | null = null;
    let pollTimer: number | undefined;
    let closeTimer: number | undefined;
    let deadlineTimer: number | undefined;
    const requests = new AbortController();
    const base = `/api/companies/${encodeURIComponent(args.companyId)}/integrations/oauth/hosted`;
    const cancelAttempt = () => {
      if (hostedAttempt)
        void api.post(`${base}/cancel`, { attempt: hostedAttempt }).catch(() => {});
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(pollTimer);
      window.clearInterval(closeTimer);
      window.clearTimeout(deadlineTimer);
      requests.abort();
      window.removeEventListener("message", message);
      args.signal.removeEventListener("abort", abort);
      try {
        popup.close();
      } catch {
        /* A provider may sever its opener. */
      }
      if (error) {
        cancelAttempt();
        reject(error);
      } else resolve();
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const message = (event: MessageEvent) => {
      // Prove which installation opened this broker window before it can
      // start Google consent. The server-held claim verifier stays private.
      if (
        hostedAttempt &&
        hostedOrigin &&
        hostedBrowserProof &&
        event.origin === hostedOrigin &&
        event.source === popup
      ) {
        const ready = event.data as { source?: string; requestId?: string } | null;
        if (
          ready?.source === "genosyn-google-sign-in-ready" &&
          ready.requestId === hostedRequestId
        ) {
          popup.postMessage(
            {
              source: "genosyn-google-sign-in-launch",
              requestId: hostedRequestId,
              proof: hostedBrowserProof,
            },
            hostedOrigin,
          );
        }
        return;
      }
      // A hosted sign-in is completed only by our authenticated polling API.
      if (!directReady || event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data as { source?: string; ok?: boolean; detail?: string } | null;
      if (!data || data.source !== "genosyn-oauth") return;
      if (data.ok === true) finish();
      else if (data.ok === false)
        finish(new Error(data.detail || "Sign-in could not be completed."));
    };
    const expire = () => finish(new Error("Sign-in timed out. Please try again."));
    deadlineTimer = window.setTimeout(expire, 10 * 60 * 1000);
    window.addEventListener("message", message);
    args.signal.addEventListener("abort", abort, { once: true });

    const poll = async () => {
      try {
        const response = await fetch(`${base}/poll`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attempt: hostedAttempt }),
          signal: requests.signal,
        });
        const data = (await response.json().catch(() => null)) as {
          status?: string;
          detail?: string;
          error?: string;
        } | null;
        if (settled) return;
        if (!response.ok)
          throw new Error(data?.error || "Gmail sign-in could not finish. Please try again.");
        if (data?.status === "complete") return finish();
        if (data?.status === "denied")
          throw new Error(data.detail || "Google sign-in was cancelled. Please try again.");
        if (data?.status !== "pending")
          throw new Error("Gmail sign-in returned an unexpected response. Please try again.");
        pollTimer = window.setTimeout(() => {
          void poll();
        }, 1500);
      } catch (error) {
        if (!settled)
          finish(error instanceof Error ? error : new Error("Gmail sign-in could not finish."));
      }
    };

    void args
      .start()
      .then((result) => {
        hostedAttempt = result.hostedAttempt;
        hostedBrowserProof = result.hostedBrowserProof;
        if (hostedAttempt) {
          const authorize = new URL(result.authorizeUrl);
          hostedOrigin = authorize.origin;
          hostedRequestId = authorize.searchParams.get("requestId");
          if (!hostedBrowserProof || !hostedRequestId)
            throw new Error("Gmail sign-in could not start. Please try again.");
        }
        if (settled) {
          cancelAttempt();
          return;
        }
        if (result.expiresAt) {
          window.clearTimeout(deadlineTimer);
          deadlineTimer = window.setTimeout(
            expire,
            Math.max(0, Math.min(10 * 60 * 1000, result.expiresAt - Date.now())),
          );
        }
        directReady = !hostedAttempt;
        popup.location.replace(result.authorizeUrl);
        args.onWaiting?.();
        if (hostedAttempt) {
          // Google can isolate a window with COOP, making `closed` appear true
          // while consent is still open. The server, deadline, or Cancel decides.
          void poll();
        } else {
          closeTimer = window.setInterval(() => {
            if (popup.closed) finish(new Error("Sign-in window closed. Please try again."));
          }, 1000);
        }
      })
      .catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error("Sign-in could not start.")),
      );
  });
}
