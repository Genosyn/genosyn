import { CalendarCheck, LifeBuoy, Target, type LucideIcon } from "lucide-react";
import { productIcon } from "@/products/productIcons";

/**
 * Icon keys referenced from roles/data.ts (which stays JSX/React-free so the
 * build-time prerenderer can import it cheaply) resolved to lucide components
 * here, on the React side.
 *
 * Roles and products draw from the same vocabulary of icons — a role's
 * capability card and the product it works in should not be drawn with two
 * different pictures of the same idea — so this delegates to the product
 * registry and only adds the handful of keys that are about a job rather than
 * a piece of software.
 */
const ROLE_ICONS: Record<string, LucideIcon> = {
  calendarCheck: CalendarCheck,
  lifeBuoy: LifeBuoy,
  target: Target,
};

export function roleIcon(key: string): LucideIcon {
  return ROLE_ICONS[key] ?? productIcon(key);
}
