import React from "react";
import { Loader2 } from "lucide-react";

type ToastKind = "info" | "error" | "success" | "loading";
type Toast = { id: number; message: string; kind: ToastKind };

type BackgroundActionOptions<T> = {
  loading: string;
  success?: string | ((result: T) => string | null);
  error?: string | ((error: unknown) => string);
  onSuccess?: (result: T) => void;
  onError?: (error: unknown) => void;
};

type Ctx = {
  toast: (message: string, kind?: Exclude<ToastKind, "loading">) => void;
  background: <T>(action: () => Promise<T>, options: BackgroundActionOptions<T>) => void;
};

const ToastContext = React.createContext<Ctx>({
  toast: () => {},
  background: () => {},
});

export function useToast() {
  return React.useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Toast[]>([]);
  const dismissLater = React.useCallback((id: number, delay = 3500) => {
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
    }, delay);
  }, []);

  const toast = React.useCallback(
    (message: string, kind: Exclude<ToastKind, "loading"> = "info") => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message, kind }]);
      dismissLater(id);
    },
    [dismissLater],
  );

  const background = React.useCallback(
    <T,>(action: () => Promise<T>, options: BackgroundActionOptions<T>) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message: options.loading, kind: "loading" }]);

      void Promise.resolve()
        .then(action)
        .then((result) => {
          options.onSuccess?.(result);
          const message =
            typeof options.success === "function" ? options.success(result) : options.success;
          if (!message) {
            setItems((prev) => prev.filter((item) => item.id !== id));
            return;
          }
          setItems((prev) =>
            prev.map((item) => (item.id === id ? { ...item, message, kind: "success" } : item)),
          );
          dismissLater(id);
        })
        .catch((error: unknown) => {
          options.onError?.(error);
          const message =
            typeof options.error === "function"
              ? options.error(error)
              : (options.error ??
                (error instanceof Error ? error.message : "The background action failed"));
          setItems((prev) =>
            prev.map((item) => (item.id === id ? { ...item, message, kind: "error" } : item)),
          );
          dismissLater(id, 6000);
        });
    },
    [dismissLater],
  );

  return (
    <ToastContext.Provider value={{ toast, background }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
        aria-live="polite"
      >
        {items.slice(-5).map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={
              "pointer-events-auto rounded-lg border px-4 py-2 text-sm shadow-sm " +
              (t.kind === "error"
                ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                : t.kind === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                  : "border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100")
            }
          >
            <span className="flex items-center gap-2">
              {t.kind === "loading" && <Loader2 size={14} className="animate-spin" />}
              {t.message}
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
