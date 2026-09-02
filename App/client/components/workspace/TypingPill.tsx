import React from "react";

import { useCompanySocketSubscription } from "@/components/CompanySocket";

/**
 * "Ada is typing…" — the only thing standing between an @mention and thirty
 * seconds of apparent silence.
 *
 * The server broadcasts a typing frame every three seconds while a mentioned
 * AI Employee composes its answer (`services/workspaceChat.ts`), and stops the
 * moment the reply lands. Both surfaces that show a channel need to render it:
 * the Workspace page always did, and the unread peek on Home — whose whole
 * pitch is "@mention an AI employee to bring them in" — dropped every frame on
 * the floor, so the one thing it advertised looked like it had done nothing.
 */

export type Typer = { kind: "user" | "ai"; id: string; name: string; until: number };

/** Grace over the server's 3s re-broadcast, so the pill doesn't flicker between frames. */
const TYPING_TTL_MS = 6_000;

/**
 * Who is currently typing in one channel, live.
 *
 * Scoped to a single channel on purpose. The page used to keep a
 * channel-keyed map of this, but nothing has ever rendered a typing hint for a
 * channel you are not looking at — the sidebar shows unread counts only — so
 * the other entries were state nobody read.
 */
export function useChannelTyping(channelId: string, meId: string): Typer[] {
  const [typers, setTypers] = React.useState<Typer[]>([]);

  // A channel switch must not carry the last room's typers across.
  React.useEffect(() => {
    setTypers([]);
  }, [channelId]);

  useCompanySocketSubscription((event) => {
    if (!("channelId" in event) || event.channelId !== channelId) return;

    if (event.type === "typing") {
      // Our own keystrokes echo back off the hub; seeing your own name in the
      // pill is the kind of small wrongness that makes people distrust it.
      if (event.by.kind === "user" && event.by.id === meId) return;
      const by = event.by;
      setTypers((prev) => [
        ...prev.filter((t) => !(t.kind === by.kind && t.id === by.id)),
        { kind: by.kind, id: by.id, name: by.name, until: Date.now() + TYPING_TTL_MS },
      ]);
      return;
    }

    // The message landing is the real end of typing — waiting for the TTL
    // would leave the pill under a reply that has already arrived.
    if (event.type === "message.new") {
      const author = event.message.author;
      if (!author || author.kind === "system") return;
      setTypers((prev) => {
        const pruned = prev.filter((t) => !(t.kind === author.kind && t.id === author.id));
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  });

  // Sweep expiries so a crashed or cancelled turn's pill fades out on its own
  // rather than sitting there for the life of the page.
  React.useEffect(() => {
    const timer = setInterval(() => {
      setTypers((prev) => {
        const now = Date.now();
        const live = prev.filter((t) => t.until > now);
        return live.length === prev.length ? prev : live;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  return typers;
}

/**
 * The pill itself. Renders only the inline label — each surface owns the tray
 * it sits in, because the Workspace's is a full-bleed rule at `px-6` and the
 * peek's is a line inside a modal.
 */
export function TypingPill({ typers }: { typers: Typer[] }) {
  const names = typers.map((t) => t.name).filter(Boolean);
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"
      role="status"
      aria-live="polite"
    >
      <TypingDots />
      {label}…
    </span>
  );
}

function TypingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400 motion-safe:animate-pulse dark:bg-slate-500 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400 motion-safe:animate-pulse dark:bg-slate-500 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400 motion-safe:animate-pulse dark:bg-slate-500" />
    </span>
  );
}
