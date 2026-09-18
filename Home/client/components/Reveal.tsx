import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const REVEAL_DURATION = 620;
const MAX_REVEAL_DELAY = 280;

/**
 * Keep the document visible by default; motion is a one-time enhancement.
 * A positive stagger reveals direct children in viewport order. The outermost
 * reveal owns its subtree, so existing Pane/Plate reveals do not animate twice.
 */
export function useReveal<T extends HTMLElement>(delay = 0, stagger = 0) {
  const ref = useRef<T>(null);
  const revealed = useRef(new WeakSet<HTMLElement>());

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const step = Number.isFinite(stagger) ? Math.max(0, stagger) : 0;
    const initialDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    const previousMarker = element.getAttribute("data-reveal");
    element.setAttribute("data-reveal", step > 0 ? "group" : "element");

    const targets =
      step > 0
        ? Array.from(element.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement,
          )
        : [element];
    const pending = new Set(targets.filter((target) => !revealed.current.has(target)));
    const animations = new Map<HTMLElement, Animation>();
    let observer: IntersectionObserver | undefined = undefined;

    const updateState = () => {
      element.dataset.revealState =
        animations.size > 0 ? "running" : pending.size > 0 ? "waiting" : "complete";
    };
    const finish = () => {
      observer?.disconnect();
      for (const target of targets) revealed.current.add(target);
      pending.clear();
      for (const [target, animation] of animations) {
        animation.onfinish = null;
        animation.cancel();
        target.dataset.revealItemState = "complete";
      }
      animations.clear();
      updateState();
    };
    const cleanup = () => {
      observer?.disconnect();
      for (const animation of animations.values()) {
        animation.onfinish = null;
        animation.cancel();
      }
      for (const target of targets) delete target.dataset.revealItemState;
      delete element.dataset.revealState;
      if (previousMarker === null) element.removeAttribute("data-reveal");
      else element.setAttribute("data-reveal", previousMarker);
    };

    updateState();
    if (
      pending.size === 0 ||
      typeof window.IntersectionObserver !== "function" ||
      typeof window.matchMedia !== "function" ||
      typeof element.animate !== "function"
    ) {
      finish();
      return cleanup;
    }

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const supportsEvents =
      typeof preference.addEventListener === "function" &&
      typeof preference.removeEventListener === "function";
    const supportsLegacyEvents =
      typeof preference.addListener === "function" &&
      typeof preference.removeListener === "function";
    if (preference.matches || (!supportsEvents && !supportsLegacyEvents)) {
      finish();
      return cleanup;
    }

    observer = new IntersectionObserver(
      (entries) => {
        // Effects on nested components have all registered before observers run.
        // Their closest marked ancestor coordinates the arrival for this subtree.
        if (
          element.parentElement?.closest("[data-reveal]") ||
          preference.matches ||
          element.contains(document.activeElement)
        ) {
          finish();
          return;
        }

        const entering = entries
          .filter((entry) => entry.isIntersecting && pending.has(entry.target as HTMLElement))
          .sort(
            (a, b) =>
              targets.indexOf(a.target as HTMLElement) - targets.indexOf(b.target as HTMLElement),
          );

        entering.forEach((entry, index) => {
          const target = entry.target as HTMLElement;
          pending.delete(target);
          revealed.current.add(target);
          observer?.unobserve(target);
          target.dataset.revealItemState = "running";

          // Stagger only this entering batch, so later rows begin promptly too.
          const animation = target.animate(
            [
              { opacity: 0, transform: "translateY(18px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            {
              duration: REVEAL_DURATION,
              delay: Math.min(MAX_REVEAL_DELAY, initialDelay + index * step),
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
              fill: "both",
            },
          );
          animations.set(target, animation);
          animation.onfinish = () => {
            // Release the transform so hover/focus transitions keep full control.
            animation.onfinish = null;
            animation.cancel();
            animations.delete(target);
            target.dataset.revealItemState = "complete";
            updateState();
          };
        });
        if (pending.size === 0) observer?.disconnect();
        updateState();
      },
      { threshold: 0.08, rootMargin: "0px 0px -16px 0px" },
    );

    // A keyboard action must never remain moving or transparent during its delay.
    const onPreferenceChange = () => {
      if (preference.matches) finish();
    };
    for (const target of pending) observer.observe(target);
    element.addEventListener("focusin", finish);
    if (supportsEvents) preference.addEventListener("change", onPreferenceChange);
    else preference.addListener(onPreferenceChange);

    return () => {
      cleanup();
      element.removeEventListener("focusin", finish);
      if (supportsEvents) preference.removeEventListener("change", onPreferenceChange);
      else preference.removeListener(onPreferenceChange);
    };
  }, [delay, stagger]);

  return ref;
}

export function Reveal({
  children,
  className = "",
  delay = 0,
  stagger = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  stagger?: number;
}) {
  const ref = useReveal<HTMLDivElement>(delay, stagger);
  return (
    <div ref={ref} className={className} data-reveal={stagger > 0 ? "group" : "element"}>
      {children}
    </div>
  );
}
