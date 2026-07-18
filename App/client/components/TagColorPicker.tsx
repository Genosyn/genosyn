import { Check } from "lucide-react";
import { TagColor } from "@/lib/api";
import { clsx } from "@/components/ui/clsx";

type TagColorOption = {
  value: TagColor;
  label: string;
  swatchClass: string;
  chipClass: string;
};

export const TAG_COLOR_OPTIONS: TagColorOption[] = [
  {
    value: "slate",
    label: "Slate",
    swatchClass: "bg-slate-500",
    chipClass:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  },
  {
    value: "red",
    label: "Red",
    swatchClass: "bg-red-500",
    chipClass:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
  },
  {
    value: "orange",
    label: "Orange",
    swatchClass: "bg-orange-500",
    chipClass:
      "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300",
  },
  {
    value: "amber",
    label: "Amber",
    swatchClass: "bg-amber-500",
    chipClass:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  },
  {
    value: "green",
    label: "Green",
    swatchClass: "bg-green-500",
    chipClass:
      "border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-300",
  },
  {
    value: "teal",
    label: "Teal",
    swatchClass: "bg-teal-500",
    chipClass:
      "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300",
  },
  {
    value: "cyan",
    label: "Cyan",
    swatchClass: "bg-cyan-500",
    chipClass:
      "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300",
  },
  {
    value: "blue",
    label: "Blue",
    swatchClass: "bg-blue-500",
    chipClass:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300",
  },
  {
    value: "indigo",
    label: "Indigo",
    swatchClass: "bg-indigo-500",
    chipClass:
      "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300",
  },
  {
    value: "violet",
    label: "Violet",
    swatchClass: "bg-violet-500",
    chipClass:
      "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
  },
  {
    value: "pink",
    label: "Pink",
    swatchClass: "bg-pink-500",
    chipClass:
      "border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-300",
  },
];

const optionsByValue = new Map(TAG_COLOR_OPTIONS.map((option) => [option.value, option]));

export function getTagColorOption(color: TagColor): TagColorOption {
  return optionsByValue.get(color) ?? TAG_COLOR_OPTIONS[0];
}

export function randomTagColor(): TagColor {
  return TAG_COLOR_OPTIONS[Math.floor(Math.random() * TAG_COLOR_OPTIONS.length)].value;
}

export function TagColorDot({ color, className }: { color: TagColor; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
        getTagColorOption(color).swatchClass,
        className,
      )}
    />
  );
}

export function TagColorPicker({
  value,
  onChange,
  label = "Color",
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
  label?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{label}</div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {TAG_COLOR_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              title={option.label}
              aria-label={option.label}
              aria-pressed={selected}
              className={clsx(
                "flex h-7 w-7 items-center justify-center rounded-full text-white transition hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:ring-offset-slate-900",
                option.swatchClass,
                selected && "ring-2 ring-indigo-500 ring-offset-2 dark:ring-offset-slate-900",
              )}
            >
              {selected && <Check size={14} strokeWidth={3} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
