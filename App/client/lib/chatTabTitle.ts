import React from "react";

/**
 * The browser tab's title while an AI Employee answers: a long reply is what
 * people switch away from, and the tab is what they glance back at.
 */
export function replyTabTitle(args: {
  employeeName: string;
  working: boolean;
  /** A reply finished while the tab was in the background, and nobody has looked yet. */
  readyWhileAway: boolean;
}): string | null {
  if (args.working) return `Working · ${args.employeeName}`;
  return args.readyWhileAway ? `Reply ready · ${args.employeeName}` : null;
}

export function useReplyTabTitle(employeeName: string, working: boolean): void {
  const [readyWhileAway, setReadyWhileAway] = React.useState(false);
  const wasWorking = React.useRef(working);

  React.useEffect(() => {
    if (wasWorking.current && !working && document.hidden) setReadyWhileAway(true);
    wasWorking.current = working;
  }, [working]);

  React.useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) setReadyWhileAway(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const title = replyTabTitle({ employeeName, working, readyWhileAway });
  React.useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
