import React from "react";
import {
  CompanySocket,
  WsInboundEvent,
  connectCompanySocket,
} from "../lib/workspace";

/**
 * Owns the single WebSocket per company that the rest of the app pulls
 * events from. Mounted at AppShell level so the bell, the workspace chat
 * surface, and any future live feature share one socket — opening another
 * connection per feature would double-deliver messages and burn server
 * slots.
 *
 * Consumers call {@link useCompanySocketSubscription} with a stable
 * handler ref to subscribe; the provider takes care of opening, closing,
 * and reconnecting.
 */

type ContextValue = {
  socket: CompanySocket | null;
  /** Connection state for any UI that wants to reflect "live" vs "offline". */
  status: "connecting" | "open" | "closed";
};

const CompanySocketContext = React.createContext<ContextValue>({
  socket: null,
  status: "closed",
});

export function CompanySocketProvider({
  companyId,
  children,
}: {
  companyId: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] =
    React.useState<ContextValue["status"]>("connecting");
  // Hold the socket in a ref so we can return its handle synchronously from
  // the context without triggering a re-render every reconnect.
  const socketRef = React.useRef<CompanySocket | null>(null);

  React.useEffect(() => {
    const sock = connectCompanySocket(companyId, setStatus);
    socketRef.current = sock;
    return () => {
      sock.close();
      socketRef.current = null;
    };
  }, [companyId]);

  const value = React.useMemo<ContextValue>(
    () => ({ socket: socketRef.current, status }),
    [status],
  );

  return (
    <CompanySocketContext.Provider value={value}>
      {children}
    </CompanySocketContext.Provider>
  );
}

export function useCompanySocket(): ContextValue {
  return React.useContext(CompanySocketContext);
}

/**
 * Subscribe to inbound events for the lifetime of the calling component.
 * The handler is called with every frame; consumers filter on `event.type`
 * for the slice they care about. Re-subscribes only when `companyId`
 * changes (the underlying socket is recreated then).
 */
export function useCompanySocketSubscription(
  handler: (event: WsInboundEvent) => void,
): void {
  const { socket } = useCompanySocket();
  // Park the handler in a ref so consumers can pass an inline arrow without
  // forcing a re-subscribe + reconnect every render.
  const ref = React.useRef(handler);
  React.useEffect(() => {
    ref.current = handler;
  }, [handler]);
  React.useEffect(() => {
    if (!socket) return;
    return socket.subscribe((event) => ref.current(event));
  }, [socket]);
}

/**
 * Re-run a page's own data loader whenever the server says a resource of one
 * of `kinds` changed in this company — the one call that makes a load-once
 * list or detail page live. Pass the same `reload`/`refresh` callback the page
 * already uses on mount.
 *
 * The server event is coarse (see `services/resourceEvents.ts`): it names a
 * `kind` and the parent `scopeIds` it touched, never row data. Give a `scopeId`
 * (a projectId, routineId, baseId, tableId…) to refetch only when *your*
 * parent changed; omit it and any change of that kind triggers a reload. A
 * burst of frames collapses into a single reload, and reloads run through the
 * normal authorized routes, so access is always re-checked.
 *
 * Nothing happens until the shared company socket is connected, and there is
 * no per-page socket — every `useLiveRefetch` shares the one
 * `CompanySocketProvider` connection.
 */
export function useLiveRefetch(
  kinds: string | string[],
  reload: () => void,
  scopeId?: string | null,
): void {
  const reloadRef = React.useRef(reload);
  const kindsRef = React.useRef<Set<string>>(new Set());
  const scopeRef = React.useRef<string | null>(scopeId ?? null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  // Rebuild the kind set each render — cheap, and keeps the handler stable so
  // the socket subscription never churns.
  kindsRef.current = new Set(Array.isArray(kinds) ? kinds : [kinds]);
  React.useEffect(() => {
    scopeRef.current = scopeId ?? null;
  }, [scopeId]);

  const handler = React.useCallback((event: WsInboundEvent) => {
    if (event.type !== "resource.changed") return;
    if (!kindsRef.current.has(event.kind)) return;
    const sc = scopeRef.current;
    if (sc && event.scopeIds.length > 0 && !event.scopeIds.includes(sc)) return;
    // Coalesce a burst (one action can touch several rows) into one reload.
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reloadRef.current();
    }, 120);
  }, []);

  useCompanySocketSubscription(handler);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}
