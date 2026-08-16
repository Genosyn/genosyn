import React from "react";
import { Check, ChevronDown, Laptop, MonitorPlay } from "lucide-react";

import { api, type MemberBrowser } from "../lib/api";
import { useToast } from "./ui/Toast";

/**
 * Which browser this conversation's browser work runs in.
 *
 * Lives in the chat header rather than the composer, next to the other
 * per-conversation facts. The composer's model picker looks similar but means
 * something different — it applies to the next message only — and two
 * identical-looking selects with opposite persistence is how people end up
 * surprised about which browser just opened their email.
 *
 * Renders nothing when the Member has no browsers of their own, so a install
 * that never uses the feature never grows a control for it.
 */
export function ChatBrowserTarget({
  companyId,
  employeeId,
  conversationId,
  browserEnabled,
  initialValue,
}: {
  companyId: string;
  employeeId: string;
  conversationId: string | null;
  browserEnabled: boolean;
  initialValue: string | null;
}) {
  const { toast } = useToast();
  const [browsers, setBrowsers] = React.useState<MemberBrowser[]>([]);
  const [open, setOpen] = React.useState(false);
  // The chat store does not carry this field through its detail refresh, so
  // the chip owns the selection after the server confirms it. Re-seeded when
  // the thread changes.
  const [value, setValue] = React.useState<string | null>(initialValue);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setValue(initialValue);
  }, [conversationId, initialValue]);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<MemberBrowser[]>(
        `/api/companies/${companyId}/member-browsers/for-employee/${employeeId}`,
      )
      .then((rows) => {
        if (!cancelled) setBrowsers(rows);
      })
      .catch(() => {
        // The instance may have member browsers disabled entirely, which
        // answers 404. That is a valid configuration, not an error to shout
        // about in a chat window.
        if (!cancelled) setBrowsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, employeeId]);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (browsers.length === 0) return null;

  const selected = value ? browsers.find((b) => b.id === value) : null;

  async function select(next: string | null) {
    setOpen(false);
    if (!conversationId) {
      setValue(next);
      return;
    }
    try {
      await api.post(`/api/companies/${companyId}/member-browsers/select/${conversationId}`, {
        memberBrowserId: next,
      });
      setValue(next);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 max-w-[13rem] items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
        title="Which browser this conversation uses"
      >
        {selected ? <Laptop size={13} /> : <MonitorPlay size={13} />}
        <span className="truncate">{selected ? selected.name : "Genosyn's browser"}</span>
        <ChevronDown size={12} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {!browserEnabled && (
            <p className="px-2 py-2 text-[11px] text-amber-600 dark:text-amber-400">
              Browser access is off for this AI Employee, so none of these are used yet. Turn it
              on in Settings → Browser.
            </p>
          )}
          <Option
            label="Genosyn's browser"
            hint="Runs inside Genosyn, on the server"
            selected={!value}
            onSelect={() => void select(null)}
          />
          {browsers.map((browser) => (
            <Option
              key={browser.id}
              label={browser.name}
              hint={
                browser.status === "online"
                  ? browser.busy
                    ? "On your computer · in use by another session"
                    : "On your computer · online"
                  : browser.status === "pending"
                    ? "Not connected yet — finish pairing on that computer"
                    : "On your computer · offline"
              }
              selected={value === browser.id}
              onSelect={() => void select(browser.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
    >
      <span className="mt-0.5 w-3.5 shrink-0">
        {selected && <Check size={13} className="text-indigo-500" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-slate-800 dark:text-slate-100">
          {label}
        </span>
        <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      </span>
    </button>
  );
}
