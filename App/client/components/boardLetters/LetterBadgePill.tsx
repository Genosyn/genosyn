import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import type { LetterBadge } from "@/lib/boardLetters";

const TONE: Record<LetterBadge["tone"], BadgeTone> = {
  good: "success",
  warn: "warning",
  bad: "danger",
  neutral: "neutral",
  working: "ai",
};

/** One of a letter's badges (`lib/boardLetters.ts`), on the Letters pages and on Home. */
export function LetterBadgePill({ badge }: { badge: LetterBadge }) {
  return (
    <Badge
      tone={TONE[badge.tone]}
      icon={badge.tone === "working" ? <Spinner size={12} /> : undefined}
    >
      {badge.label}
    </Badge>
  );
}
