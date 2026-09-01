import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { DecisionCard } from "@/components/decisions/DecisionCard";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "@/components/ui/Avatar";
import { Button, buttonClassName } from "@/components/ui/Button";
import type { Company, Decision, Notification, NotificationEntityKind } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";

/**
 * What a notification actually says, without leaving Home to find out.
 *
 * Two things were wrong with the old row. It threw `body` away — the sentence
 * that answers "what happened?" was already in the payload and never rendered.
 * And it marked the notification read *and then* navigated, so a mis-click
 * silently removed a row from a card that only ever lists unread ones: you
 * could lose the thing that was trying to reach you by brushing it.
 *
 * Now the click opens this, reading marks read, and the destination is a
 * button you press on purpose. Where the linked thing is already on the page —
 * a pending decision — it is embedded outright, so the notification can be
 * answered rather than merely read.
 */

/** What the "go there" button should call the destination. */
function destinationLabel(entityKind: NotificationEntityKind | null): string {
  switch (entityKind) {
    case "todo":
      return "Open the todo";
    case "approval":
      return "Open approvals";
    case "decision":
      return "Open decisions";
    case "run":
      return "Open the run";
    case "channel_message":
      return "Open the conversation";
    case "revision_proposal":
      return "Open the proposal";
    case "handoff":
      return "Open the handover";
    case "goal":
      return "Open the goal";
    case "initiative":
      return "Open the initiative";
    default:
      return "Open";
  }
}

export function NotificationPeekModal({
  company,
  notification,
  /** The pending decision this notification is about, when Home already has it. */
  decision,
  onClose,
  onChanged,
}: {
  company: Company;
  notification: Notification;
  decision: Decision | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const actor = notification.actor;
  const actorSrc = actor?.id
    ? actor.kind === "user"
      ? memberAvatarUrl(company.id, actor.id, actor.avatarKey)
      : actor.kind === "ai"
        ? employeeAvatarUrl(company.id, actor.id, actor.avatarKey)
        : null
    : null;

  const when = new Date(notification.createdAt);

  return (
    <Modal
      open
      onClose={onClose}
      title={notification.title}
      description={when.toLocaleString()}
      size="lg"
      footer={
        <>
          {notification.link && (
            <Link
              to={notification.link}
              className={buttonClassName({ variant: "secondary", size: "sm" })}
              onClick={onClose}
            >
              <ExternalLink size={14} /> {destinationLabel(notification.entityKind)}
            </Link>
          )}
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {actor && (
          <div className="flex items-center gap-2">
            <Avatar
              name={actor.name}
              src={actorSrc}
              kind={actor.kind === "ai" ? "ai" : "human"}
              size="sm"
            />
            <span className="text-sm text-slate-700 dark:text-slate-200">{actor.name}</span>
          </div>
        )}

        {notification.body && (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700 dark:text-slate-200">
            {notification.body}
          </p>
        )}

        {/* A blocked employee is the one notification kind you can finish
            here: the same card the Decision Stack renders, so answering from
            a notification and answering from the stack are the same act. */}
        {decision && (
          <div className="overflow-hidden rounded-xl border border-violet-200 dark:border-violet-500/30">
            <ul className="divide-y divide-violet-100 dark:divide-violet-500/15">
              <DecisionCard
                company={company}
                decision={decision}
                onResolved={() => {
                  onChanged();
                  onClose();
                }}
              />
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
