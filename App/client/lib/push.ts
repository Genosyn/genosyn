import { api } from "./api";

/**
 * Client side of Web Push. The server mints the VAPID keypair on first use
 * (zero-config for self-hosters); this module owns the browser half:
 * permission prompt, PushManager subscription, and registering the
 * subscription with the server so notification fan-out reaches this device.
 *
 * Support notes:
 *   - Requires a secure context (https or localhost).
 *   - iOS Safari only exposes PushManager once the app is installed to the
 *     home screen (16.4+), so `pushSupported()` is false in the plain tab.
 *   - `enablePush()` must run from a user gesture or the permission prompt
 *     is auto-denied.
 */

export type PushState =
  | "unsupported"
  | "denied"
  | "subscribed"
  | "unsubscribed";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * The prod build registers /sw.js from main.tsx; in dev (or before that
 * registration settled) we register on demand — a subscription needs a
 * live worker to attach to.
 */
async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js");
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) {
    throw new Error(
      "This browser doesn't support push notifications. On iPhone/iPad, install Genosyn to your home screen first.",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      "Notification permission was not granted. Enable notifications for this site in your browser settings.",
    );
  }
  const reg = await getRegistration();
  const { key } = await api.get<{ key: string }>("/api/push/vapid-public-key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }
  await api.post("/api/push/subscriptions", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await api.post("/api/push/subscriptions/remove", { endpoint });
  } catch {
    // Server cleanup is best-effort — a dead endpoint also gets dropped on
    // the next send when the push service returns 404/410.
  }
}

/** Standard VAPID key conversion (base64url → Uint8Array). The explicit
 * ArrayBuffer keeps TS happy about `BufferSource` (no SharedArrayBuffer). */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
