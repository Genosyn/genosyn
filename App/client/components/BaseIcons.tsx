import React from "react";
import {
  Database,
  Users,
  UserCheck,
  PenLine,
  FolderKanban,
  Briefcase,
  Box,
  Target,
  LifeBuoy,
  Calendar,
  Rocket,
  Heart,
  Bug,
  type LucideIcon,
} from "lucide-react";
import type { BaseColor } from "../lib/api";

/**
 * Curated icon set for Bases. Keeps the picker small (no raw lucide-import
 * grazing) and lets us rename the mapping later without migrating data —
 * unknown names fall back to Database.
 */
const REGISTRY: Record<string, LucideIcon> = {
  Database,
  Users,
  UserCheck,
  PenLine,
  FolderKanban,
  Briefcase,
  Box,
  Target,
  LifeBuoy,
  Calendar,
  Rocket,
  Heart,
  Bug,
};

export const BASE_ICON_NAMES = Object.keys(REGISTRY);

export function BaseIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = REGISTRY[name] ?? Database;
  return <Icon size={size} />;
}

type AccentKind = "tile" | "border" | "text";

const TILE: Record<BaseColor, string> = {
  indigo: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  rose: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  slate: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

const BORDER: Record<BaseColor, string> = {
  indigo: "border-indigo-300 dark:border-indigo-700",
  emerald: "border-emerald-300 dark:border-emerald-700",
  amber: "border-amber-300 dark:border-amber-700",
  rose: "border-rose-300 dark:border-rose-700",
  sky: "border-sky-300 dark:border-sky-700",
  violet: "border-violet-300 dark:border-violet-700",
  slate: "border-slate-300 dark:border-slate-700",
};

const TEXT: Record<BaseColor, string> = {
  indigo: "text-indigo-700 dark:text-indigo-300",
  emerald: "text-emerald-700 dark:text-emerald-300",
  amber: "text-amber-700 dark:text-amber-300",
  rose: "text-rose-700 dark:text-rose-300",
  sky: "text-sky-700 dark:text-sky-300",
  violet: "text-violet-700 dark:text-violet-300",
  slate: "text-slate-700 dark:text-slate-300",
};

export function baseAccent(color: string, kind: AccentKind): string {
  const c = (color in TILE ? color : "indigo") as BaseColor;
  switch (kind) {
    case "tile":
      return TILE[c];
    case "border":
      return BORDER[c];
    case "text":
      return TEXT[c];
  }
}

export const BASE_COLORS: BaseColor[] = [
  "indigo",
  "emerald",
  "amber",
  "rose",
  "sky",
  "violet",
  "slate",
];

/** Tailwind classes for a colored chip — used for select field pills. */
export function chipClass(color: string): string {
  const map: Record<string, string> = {
    indigo:
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
    emerald:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    amber:
      "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    rose: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
    sky: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    violet:
      "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
    slate:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  };
  return map[color] ?? map.slate;
}

export const CHIP_COLORS = [
  "indigo",
  "emerald",
  "amber",
  "rose",
  "sky",
  "violet",
  "slate",
];
