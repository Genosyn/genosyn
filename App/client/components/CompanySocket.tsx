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
