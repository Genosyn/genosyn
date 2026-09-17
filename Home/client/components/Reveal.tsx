import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/** Keep the document visible by default; motion is a one-time enhancement. */
export function useReveal<T extends HTMLElement>(delay = 0) {
  const ref = useRef<T>(null);
  const revealed = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (
      !element ||
      revealed.current ||
      typeof window.IntersectionObserver !== "function" ||
      typeof window.matchMedia !== "function" ||
      typeof element.animate !== "function"
    ) {
      return;
    }

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;

    let animation: Animation | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || revealed.current) return;
        revealed.current = true;
        observer.disconnect();
        if (preference.matches || element.contains(document.activeElement)) return;

        animation = element.animate(
          [
            { opacity: 0, transform: "translateY(18px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          {
            duration: 650,
            delay: Math.max(0, delay),
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "both",
          },
        );
        animation.onfinish = () => {
          animation?.cancel();
          animation = undefined;
        };
      },
      { threshold: 0.08, rootMargin: "0px 0px -24px 0px" },
    );

    // Focusing an action must never leave it moving or temporarily transparent.
    const finish = () => {
      revealed.current = true;
      observer.disconnect();
      animation?.cancel();
      animation = undefined;
    };
    const onPreferenceChange = () => {
      if (preference.matches) finish();
    };

    observer.observe(element);
    element.addEventListener("focusin", finish);
    if (typeof preference.addEventListener === "function") {
      preference.addEventListener("change", onPreferenceChange);
    } else {
      preference.addListener(onPreferenceChange);
    }

    return () => {
      observer.disconnect();
      animation?.cancel();
      element.removeEventListener("focusin", finish);
      if (typeof preference.removeEventListener === "function") {
        preference.removeEventListener("change", onPreferenceChange);
      } else {
        preference.removeListener(onPreferenceChange);
      }
    };
  }, [delay]);

  return ref;
}

export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useReveal<HTMLDivElement>(delay);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
