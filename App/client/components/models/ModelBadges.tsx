import React from "react";
import { BrainCircuit, Check, CloudOff, KeyRound, Loader2, LogIn, Server } from "lucide-react";
import type { AIModel } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";

/**
 * Connected, still waiting for its credential, or connected but unavailable
 * right now — its service down, failing, overloaded or rate-limited, with its
 * work waiting for it.
 */
export function ModelStatusBadge({
  connected,
  unavailable = false,
}: {
  connected: boolean;
  unavailable?: boolean;
}) {
  if (connected && unavailable) {
    return (
      <Badge tone="warning" icon={<CloudOff />}>
        Unavailable
      </Badge>
    );
  }
  if (connected) {
    return (
      <Badge tone="success" icon={<Check />}>
        Connected
      </Badge>
    );
  }
  return (
    <Badge tone="warning" icon={<Loader2 className="animate-spin" />}>
      Waiting
    </Badge>
  );
}

/** The model chat and Routines use, when an employee has more than one. */
export function ModelActiveBadge() {
  return (
    <Badge tone="accent" icon={<BrainCircuit />}>
      Active
    </Badge>
  );
}

/**
 * How the model connects, at a glance: a key, a ChatGPT sign-in, or a server
 * of the company's own. Decorative — the card's text says the same thing.
 */
export function ModelKindIcon({ model }: { model: Pick<AIModel, "authMode"> }) {
  const Icon =
    model.authMode === "customEndpoint"
      ? Server
      : model.authMode === "subscription"
        ? LogIn
        : KeyRound;
  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
    >
      <Icon size={16} />
    </span>
  );
}
