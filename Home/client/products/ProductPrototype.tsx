import { useEffect, useMemo, useState } from "react";
import { Check, CirclePause, CirclePlay, MousePointer2, Sparkles } from "lucide-react";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { productPreview } from "@/products/previews";

type PrototypeStory = {
  label: string;
  detail: string;
};

const STORY_DURATION_MS = 3600;

const PRODUCT_STORIES: Record<string, PrototypeStory[]> = {
  "ai-employees": [
    {
      label: "Routine started",
      detail: "Mira opened the daily reconciliation brief.",
    },
    {
      label: "Working with Grants",
      detail: "42 Stripe charges matched against the ledger.",
    },
    {
      label: "Run shipped",
      detail: "0 anomalies found · full transcript saved.",
    },
  ],
  workspace: [
    {
      label: "Mention received",
      detail: "Alex joined #marketing and read the thread.",
    },
    {
      label: "Drafting in channel",
      detail: "The Friday digest is being assembled from shared files.",
    },
    {
      label: "Reply posted",
      detail: "Preview shared with the team for review.",
    },
  ],
  tasks: [
    {
      label: "Todo assigned",
      detail: "Sam picked up the checkout reliability review.",
    },
    {
      label: "Work in progress",
      detail: "Logs and the latest deployment are being checked.",
    },
    {
      label: "Ready for review",
      detail: "Findings moved to the human review queue.",
    },
  ],
  bases: [
    {
      label: "Record changed",
      detail: "A customer moved from Trial to Pro.",
    },
    {
      label: "View refreshed",
      detail: "Renewal risk and MRR fields recalculated.",
    },
    {
      label: "Team notified",
      detail: "The account owner received a workspace update.",
    },
  ],
  notes: [
    {
      label: "Brief opened",
      detail: "Alex found the launch narrative in shared notes.",
    },
    {
      label: "Page updated",
      detail: "Research and customer language added to the draft.",
    },
    {
      label: "Change saved",
      detail: "The new version is ready for the team.",
    },
  ],
  resources: [
    {
      label: "Source added",
      detail: "A billing guide was saved to the company library.",
    },
    {
      label: "Content extracted",
      detail: "The document is searchable and ready for AI employees.",
    },
    {
      label: "Resource cited",
      detail: "Mira linked the source in her reconciliation Run.",
    },
  ],
  pipelines: [
    {
      label: "Trigger received",
      detail: "Stripe reported a payment above $1,000.",
    },
    {
      label: "Branch matched",
      detail: "The high-value customer path was selected.",
    },
    {
      label: "Action completed",
      detail: "A win was posted and the account record updated.",
    },
  ],
  explore: [
    {
      label: "Query running",
      detail: "Monthly recurring revenue is loading from Postgres.",
    },
    {
      label: "Chart refreshed",
      detail: "June closed at $48,220 · up 8.4%.",
    },
    {
      label: "Dashboard shared",
      detail: "The latest view is available to the company.",
    },
  ],
  marketing: [
    {
      label: "Spend reviewed",
      detail: "Alex compared campaign CPA with the company target.",
    },
    {
      label: "Change proposed",
      detail: "Brand Search budget increase is ready for approval.",
    },
    {
      label: "Human check required",
      detail: "The change is paused until a Member approves it.",
    },
  ],
  revenue: [
    {
      label: "Signal fired",
      detail: "Acme crossed the product-usage threshold.",
    },
    {
      label: "Deal updated",
      detail: "The expansion value and next step were refreshed.",
    },
    {
      label: "Sequence queued",
      detail: "A personal follow-up is ready for review.",
    },
  ],
  email: [
    {
      label: "Inbox triaged",
      detail: "Mira found three messages needing a reply.",
    },
    {
      label: "Draft prepared",
      detail: "The customer context was pulled from the company.",
    },
    {
      label: "Waiting for review",
      detail: "The reply is drafted but has not been sent.",
    },
  ],
  customers: [
    {
      label: "Health recalculated",
      detail: "Usage and support activity were combined.",
    },
    {
      label: "Risk detected",
      detail: "Northstar moved to Watch with two clear reasons.",
    },
    {
      label: "Owner notified",
      detail: "A recovery task was created for the account team.",
    },
  ],
  finance: [
    {
      label: "Payment imported",
      detail: "42 Stripe charges arrived for reconciliation.",
    },
    {
      label: "Ledger matched",
      detail: "41 entries matched automatically.",
    },
    {
      label: "Exception surfaced",
      detail: "One charge is waiting for a Member to classify it.",
    },
  ],
  code: [
    {
      label: "Repository opened",
      detail: "Sam checked the failing checkout service.",
    },
    {
      label: "Patch prepared",
      detail: "Tests pass and the diff is ready to inspect.",
    },
    {
      label: "Review requested",
      detail: "The branch is waiting for a human merge.",
    },
  ],
};

type ProductPrototypeProps = {
  product?: ProductDef;
  className?: string;
  compact?: boolean;
};

export function ProductPrototype({
  product,
  className = "",
  compact = false,
}: ProductPrototypeProps) {
  const [activeSlug, setActiveSlug] = useState(product?.slug ?? "ai-employees");
  const [storyIndex, setStoryIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  const activeProduct = useMemo(
    () => PRODUCTS.find((candidate) => candidate.slug === activeSlug) ?? PRODUCTS[0],
    [activeSlug],
  );
  const stories = PRODUCT_STORIES[activeProduct.slug] ?? [];
  const story = stories[storyIndex] ?? stories[0];
  const Preview = productPreview(activeProduct.slug);

  useEffect(() => {
    setActiveSlug(product?.slug ?? "ai-employees");
    setStoryIndex(0);
  }, [product?.slug]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsPlaying(false);
    }
  }, []);

  useEffect(() => {
    if (!isPlaying || stories.length === 0) return;
    const timer = window.setTimeout(() => {
      const nextStory = storyIndex + 1;
      if (nextStory < stories.length) {
        setStoryIndex(nextStory);
        return;
      }

      setStoryIndex(0);
      if (!product) {
        const currentProductIndex = PRODUCTS.findIndex(
          (candidate) => candidate.slug === activeSlug,
        );
        setActiveSlug(PRODUCTS[(currentProductIndex + 1) % PRODUCTS.length].slug);
      }
    }, STORY_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [activeSlug, isPlaying, product, stories.length, storyIndex]);

  function selectProduct(slug: string) {
    setActiveSlug(slug);
    setStoryIndex(0);
    setIsPlaying(true);
  }

  function selectStory(index: number) {
    setStoryIndex(index);
    setIsPlaying(false);
  }

  return (
    <section
      aria-label={`Interactive ${activeProduct.name} product preview`}
      className={`prototype-shell overflow-hidden rounded-[1.4rem] border border-zinc-200 bg-white shadow-[0_24px_70px_-30px_rgba(15,23,42,0.35)] ${className}`}
    >
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3.5 py-3 text-white sm:px-4">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-emerald-300 ring-1 ring-emerald-400/20">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          Live prototype
        </span>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-white">{activeProduct.name}</div>
          <div className="hidden truncate text-[9px] text-zinc-400 sm:block">
            Follow the work as it moves through Genosyn
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsPlaying((playing) => !playing)}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[10px] font-semibold text-zinc-200 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/40"
          aria-label={isPlaying ? "Pause prototype" : "Play prototype"}
        >
          {isPlaying ? (
            <CirclePause className="h-3.5 w-3.5" />
          ) : (
            <CirclePlay className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{isPlaying ? "Pause" : "Play"}</span>
        </button>
      </div>

      {product ? (
        <div
          className="grid grid-cols-3 border-b border-zinc-200 bg-zinc-50/80"
          aria-label="Prototype steps"
        >
          {stories.map((candidate, index) => (
            <button
              key={candidate.label}
              type="button"
              onClick={() => selectStory(index)}
              className={`relative min-w-0 px-2 py-2.5 text-left transition sm:px-3 ${
                index === storyIndex
                  ? "bg-white text-zinc-950"
                  : "text-zinc-500 hover:bg-white/70 hover:text-zinc-800"
              }`}
              aria-pressed={index === storyIndex}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold ${
                    index < storyIndex
                      ? "bg-emerald-100 text-emerald-700"
                      : index === storyIndex
                        ? "bg-zinc-950 text-white"
                        : "bg-zinc-200 text-zinc-500"
                  }`}
                >
                  {index < storyIndex ? <Check className="h-2.5 w-2.5" /> : index + 1}
                </span>
                <span className="truncate text-[9px] font-semibold sm:text-[10px]">
                  {candidate.label}
                </span>
              </span>
              {index === storyIndex && isPlaying && (
                <span className="prototype-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-zinc-950" />
              )}
            </button>
          ))}
        </div>
      ) : (
        <div
          className="scrollbar-none flex gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50/80 p-1.5"
          aria-label="Choose a product to preview"
        >
          {PRODUCTS.map((candidate) => {
            const Icon = productIcon(candidate.icon);
            const active = candidate.slug === activeSlug;
            return (
              <button
                key={candidate.slug}
                type="button"
                onClick={() => selectProduct(candidate.slug)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[10px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                  active
                    ? "bg-zinc-950 text-white shadow-sm"
                    : "text-zinc-600 hover:bg-white hover:text-zinc-950"
                }`}
                aria-pressed={active}
              >
                <Icon className="h-3 w-3" />
                {candidate.name}
              </button>
            );
          })}
        </div>
      )}

      <div
        key={`${activeSlug}-${storyIndex}`}
        className={`prototype-stage relative bg-zinc-100/70 ${compact ? "prototype-stage-compact" : ""}`}
      >
        {Preview && <Preview />}

        {story && (
          <div className="prototype-activity pointer-events-none absolute bottom-3 left-3 right-3 flex items-center gap-2.5 rounded-xl border border-zinc-200/90 bg-white/95 px-3 py-2.5 shadow-lift backdrop-blur sm:left-auto sm:max-w-[21rem]">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-950">
                {story.label}
                <MousePointer2 className="h-2.5 w-2.5 text-zinc-400" />
              </span>
              <span className="mt-0.5 block truncate text-[9px] text-zinc-500 sm:text-[10px]">
                {story.detail}
              </span>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
