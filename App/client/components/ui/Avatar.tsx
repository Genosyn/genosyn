import React from "react";
import { clsx } from "./clsx";

/**
 * Renders a profile picture for a human member or an AI employee. When the
 * backend has an avatar on file (`src` resolves + loads), the `<img>` is
 * shown; otherwise falls back to a generated initials pill so the UI
 * doesn't flash an empty square.
 *
 * Callers always pass `name` so the initials fallback is consistent — the
 * same letters render whether or not the avatar resource is present.
 */
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-16 w-16 text-base",
};

type AvatarProps = {
  name: string;
  src?: string | null;
  kind?: "human" | "ai";
  size?: AvatarSize;
  className?: string;
  title?: string;
};

export function Avatar({
  name,
  src,
  kind = "human",
  size = "md",
  className,
  title,
}: AvatarProps) {
  const [failed, setFailed] = React.useState(false);
  const show = !!src && !failed;

  // Reset error state whenever the caller swaps to a new URL — otherwise an
  // upload that changes the src would still render the fallback.
  React.useEffect(() => {
    setFailed(false);
  }, [src]);

  const initials = deriveInitials(name);
  const base = clsx(
    "inline-flex shrink-0 items-center justify-center rounded-full font-semibold overflow-hidden select-none",
    SIZE_CLASS[size],
    className,
  );

  if (show) {
    return (
      <span className={base} title={title ?? name}>
        <img
          src={src!}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  const tone =
    kind === "ai"
      ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
      : "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200";

  return (
    <span className={clsx(base, tone)} title={title ?? name} aria-label={name}>
      {initials}
    </span>
  );
}

function deriveInitials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * URL helpers — centralized so a page never hardcodes the avatar endpoint
 * shape. Pass `avatarKey` so callers don't hit the endpoint when the row
 * has no avatar (the server would 404, which still renders the fallback
 * but wastes a request).
 */
export function employeeAvatarUrl(
  companyId: string,
  employeeId: string,
  avatarKey?: string | null,
): string | null {
  if (!avatarKey) return null;
  return `/api/companies/${companyId}/employees/${employeeId}/avatar?v=${encodeURIComponent(avatarKey)}`;
}

export function meAvatarUrl(avatarKey?: string | null): string | null {
  if (!avatarKey) return null;
  return `/api/auth/me/avatar?v=${encodeURIComponent(avatarKey)}`;
}

export function memberAvatarUrl(
  companyId: string,
  userId: string,
  avatarKey?: string | null,
): string | null {
  if (!avatarKey) return null;
  return `/api/companies/${companyId}/members/${userId}/avatar?v=${encodeURIComponent(avatarKey)}`;
}
