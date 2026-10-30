import React from "react";

import { useCompanySocket, useCompanySocketSubscription } from "@/components/CompanySocket";
import { LiveTurnCard } from "@/components/chat/TurnActivity";
import { useFollowedTurn } from "@/components/chat/useFollowedTurn";
import { ChatAuthorAvatar } from "@/components/workspace/MessageList";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  workspaceApi,
  type GroupDiscussion,
  type WorkspaceMessage,
  type WorkspaceTurn,
} from "@/lib/workspace";
import {
  applyTurnUpdate,
  dropAnsweredTurns,
  stepsVisibilityNote,
  turnAccessFor,
  turnCardContext,
} from "@/lib/workspaceTurns";

/**
 * The AI Employees working in a Workspace room right now, and what each one
 * is doing — the same live card the direct chat shows, one per turn, under the
 * conversation where the typing pill used to be.
 *
 * Each card follows its turn over the turn's own stream, which the server
 * shapes for this reader (`shared/turnActivityAccess.ts`): the Member whose
 * access the turn uses sees every step in full, everyone else the steps
 * without what they read or returned. Several AI Employees replying at once
 * are several cards; a group discussion's speaker is one, with its round; an
 * AI colleague answering an @mention is one too. The room learns a turn
 * started, waits or ended from the company socket (`turn.update`), and a card
 * leaves when its reply lands.
 */

/** The turns running in one room, live. */
export function useChannelTurns(
  companyId: string,
  channelId: string,
): {
  running: WorkspaceTurn[];
  /** A turn this browser started or heard about directly — a Retry's. */
  apply: (turn: WorkspaceTurn) => void;
  /** A turn ended in this browser's own stream, or its reply arrived. */
  ended: (turnId: string) => void;
} {
  const [running, setRunning] = React.useState<WorkspaceTurn[]>([]);
  const { status } = useCompanySocket();
  const [reloads, setReloads] = React.useState(0);
  const lastStatus = React.useRef(status);

  // The socket replays nothing it missed, so a reconnect re-reads the room.
  React.useEffect(() => {
    if (lastStatus.current !== "open" && status === "open" && lastStatus.current !== "connecting") {
      setReloads((value) => value + 1);
    }
    lastStatus.current = status;
  }, [status]);

  React.useEffect(() => {
    let cancelled = false;
    setRunning((current) => (current.length && current[0].channelId !== channelId ? [] : current));
    workspaceApi
      .listTurns(companyId, channelId)
      .then((turns) => {
        if (!cancelled) setRunning(turns.filter((turn) => turn.status === "working"));
      })
      .catch(() => {
        // The cards decorate a room; its messages still read without them.
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, channelId, reloads]);

  useCompanySocketSubscription((event) => {
    if (!("channelId" in event) || event.channelId !== channelId) return;
    if (event.type === "turn.update") {
      setRunning((current) => applyTurnUpdate(current, event.turn));
    } else if (event.type === "message.new") {
      setRunning((current) => dropAnsweredTurns(current, event.message));
    }
  });

  const ended = React.useCallback((turnId: string) => {
    setRunning((current) => {
      const next = current.filter((turn) => turn.id !== turnId);
      return next.length === current.length ? current : next;
    });
  }, []);
  const apply = React.useCallback((turn: WorkspaceTurn) => {
    setRunning((current) => applyTurnUpdate(current, turn));
  }, []);

  return { running, apply, ended };
}

export function ChannelTurnCards({
  company,
  meId,
  turns,
  discussions,
  onEnded,
  onReply,
}: {
  company: Company;
  meId: string;
  turns: WorkspaceTurn[];
  /** The room's discussions, for a discussion turn's round count. */
  discussions: GroupDiscussion[];
  onEnded: (turnId: string) => void;
  /** The reply a turn wrote, as its stream handed it over. */
  onReply: (message: WorkspaceMessage) => void;
}) {
  if (turns.length === 0) return null;
  return (
    <div className="space-y-3 pt-3" aria-label="AI Employees working here">
      {turns.map((turn) => (
        <ChannelTurnCard
          key={turn.id}
          company={company}
          meId={meId}
          turn={turn}
          rounds={
            turn.discussionId
              ? (discussions.find((d) => d.id === turn.discussionId)?.rounds ?? null)
              : null
          }
          onEnded={onEnded}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function ChannelTurnCard({
  company,
  meId,
  turn,
  rounds,
  onEnded,
  onReply,
}: {
  company: Company;
  meId: string;
  turn: WorkspaceTurn;
  rounds: number | null;
  onEnded: (turnId: string) => void;
  onReply: (message: WorkspaceMessage) => void;
}) {
  const [stopping, setStopping] = React.useState(false);
  const [stopError, setStopError] = React.useState<string | null>(null);
  const streamUrl = React.useCallback(
    (after: number) => workspaceApi.turnStreamUrl(company.id, turn.channelId, turn.id, after),
    [company.id, turn.channelId, turn.id],
  );
  const followed = useFollowedTurn({
    streamUrl,
    turnId: turn.id,
    startedAt: Date.parse(turn.startedAt) || null,
    onEnd: (_event, data) => {
      const message = (data as { message?: WorkspaceMessage | null } | null)?.message;
      if (message) onReply(message);
      onEnded(turn.id);
    },
  });
  const name = turn.employee?.name ?? "AI Employee";
  const access = followed.access ?? turnAccessFor(turn, meId);

  async function stop() {
    setStopping(true);
    setStopError(null);
    try {
      await workspaceApi.stopTurn(company.id, turn.channelId, turn.id);
    } catch (err) {
      setStopping(false);
      setStopError(errorMessage(err, `Could not stop ${name}`));
    }
  }

  return (
    <div className="px-2" data-channel-turn={turn.id} data-turn-kind={turn.kind}>
      <LiveTurnCard
        authorName={name}
        avatar={
          <ChatAuthorAvatar
            author={
              turn.employee
                ? { kind: "ai", ...turn.employee }
                : { kind: "ai", id: turn.id, name, slug: "", role: "" }
            }
          />
        }
        live={followed.live}
        streamingReply={followed.text || null}
        progress={followed.progress}
        connectionState={followed.connection}
        stopping={stopping}
        // A discussion's turns stop with the discussion, from its bar.
        onStop={turn.kind === "reply" ? () => void stop() : undefined}
        companySlug={company.slug}
        context={turnCardContext(turn, { meId, rounds })}
        note={stepsVisibilityNote(access, turn)}
        stopError={stopError}
      />
    </div>
  );
}
