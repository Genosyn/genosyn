import React from "react";
import type { LucideIcon } from "lucide-react";

/**
 * Contextual actions the ⌘K palette can run.
 *
 * The palette started life as pure navigation — every row was a place to go.
 * Power users want it to *do* things too ("archive these", "send all drafts"),
 * but only the page currently on screen knows which verbs make sense. So pages
 * register commands here and the palette renders whatever is registered.
 *
 * Registrations live in a ref rather than state on purpose. A page registering
 * during render must not re-render the whole tree, and the palette only needs
 * the list at the moment it opens — so it takes a snapshot on mount instead of
 * subscribing. That keeps a mis-memoised caller from turning into a render loop.
 */

export type Command = {
  id: string;
  label: string;
  /** Extra words that should match this command when typed. */
  keywords?: string[];
  hint?: string;
  icon?: LucideIcon;
  group?: string;
  run: () => void;
};

type Registry = {
  register: (key: string, commands: Command[]) => void;
  unregister: (key: string) => void;
  snapshot: () => Command[];
};

const CommandRegistryContext = React.createContext<Registry | null>(null);

export function CommandRegistryProvider({ children }: { children: React.ReactNode }) {
  const store = React.useRef(new Map<string, Command[]>());

  const value = React.useMemo<Registry>(
    () => ({
      register: (key, commands) => {
        store.current.set(key, commands);
      },
      unregister: (key) => {
        store.current.delete(key);
      },
      snapshot: () => [...store.current.values()].flat(),
    }),
    [],
  );

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  );
}

/**
 * Publish commands for as long as the calling component is mounted.
 *
 * Pass a memoised array — an inline literal re-registers on every render, which
 * is wasteful even though it cannot loop here.
 */
export function useRegisterCommands(commands: Command[]): void {
  const key = React.useId();
  const registry = React.useContext(CommandRegistryContext);

  React.useEffect(() => {
    if (!registry) return;
    registry.register(key, commands);
    return () => registry.unregister(key);
  }, [registry, key, commands]);
}

/** Everything registered right now. Returns [] outside a provider. */
export function useCommandSnapshot(): Command[] {
  const registry = React.useContext(CommandRegistryContext);
  // Snapshot once per mount: the palette mounts when it opens and unmounts when
  // it closes, so "once per mount" is exactly "once per open".
  return React.useMemo(() => registry?.snapshot() ?? [], [registry]);
}

/** Substring match over label + keywords, ranked by where the hit lands. */
export function searchCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const scored: Array<{ command: Command; score: number }> = [];
  for (const command of commands) {
    const label = command.label.toLowerCase();
    const at = label.indexOf(q);
    if (at === 0) scored.push({ command, score: 0 });
    else if (at > 0) scored.push({ command, score: 1 });
    else if ((command.keywords ?? []).some((k) => k.toLowerCase().includes(q))) {
      scored.push({ command, score: 2 });
    }
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.command);
}
