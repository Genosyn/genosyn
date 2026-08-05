import { useEffect, useState } from "react";
import { Check, Clock3, LockKeyhole, Sparkles } from "lucide-react";
import { PRODUCTS, type ProductDef } from "@/products/data";
import { productIcon } from "@/products/productIcons";
import { productPreview } from "@/products/previews";
import { LogoMark } from "@/components/Logo";
import {
  primaryUseCaseForProduct,
  SHOWCASE_USE_CASES,
  type ProductUseCase,
} from "@/products/useCases";

type PrototypeStory = {
  label: string;
  detail: string;
};

const STORY_DURATION_MS = 3200;

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
      detail: "One exception routed for a Member to review.",
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
      detail: "The draft was shared with the team for review.",
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
      detail: "Research and customer language were added to the draft.",
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
      detail: "The document is searchable by AI Employees.",
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
      detail: "The account record was updated and the team notified.",
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
      detail: "The latest operating view is available to the company.",
    },
  ],
  marketing: [
    {
      label: "Spend reviewed",
      detail: "Alex compared campaign CPA with the company target.",
    },
    {
      label: "Change proposed",
      detail: "A Brand Search budget increase is ready for approval.",
    },
    {
      label: "Human check required",
      detail: "The change is paused until a Member approves it.",
    },
  ],
  revenue: [
    {
      label: "Signal fired",
      detail: "Acme crossed the high-intent usage threshold.",
    },
    {
      label: "Context assembled",
      detail: "The Contact, activity, and Deal were reviewed.",
    },
    {
      label: "Sequence queued",
      detail: "A personal follow-up is ready for human review.",
    },
  ],
  email: [
    {
      label: "Inbox triaged",
      detail: "Mira found three messages needing a reply.",
    },
    {
      label: "Draft prepared",
      detail: "Customer context was pulled from the company.",
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
      detail: "A recovery todo was created for the account team.",
    },
  ],
  finance: [
    {
      label: "Payments imported",
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
      detail: "Sam inspected the failing checkout service.",
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
  const [showcaseIndex, setShowcaseIndex] = useState(0);
  const [storyIndex, setStoryIndex] = useState(0);
  const [motionEnabled, setMotionEnabled] = useState(true);

  const activeUseCase = product
    ? primaryUseCaseForProduct(product.slug)
    : SHOWCASE_USE_CASES[showcaseIndex];
  const activeProduct =
    product ??
    PRODUCTS.find((candidate) => candidate.slug === activeUseCase.primaryProductSlug) ??
    PRODUCTS[0];
  const stories = PRODUCT_STORIES[activeProduct.slug] ?? [];
  const story = stories[storyIndex] ?? stories[0];
  const Preview = productPreview(activeProduct.slug);
  const ActiveIcon = productIcon(activeProduct.icon);

  useEffect(() => {
    setShowcaseIndex(0);
    setStoryIndex(0);
  }, [product?.slug]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMotionEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!motionEnabled || stories.length === 0) return;
    const timer = window.setTimeout(() => {
      if (storyIndex < stories.length - 1) {
        setStoryIndex((current) => current + 1);
        return;
      }

      setStoryIndex(0);
      if (!product) {
        setShowcaseIndex((current) => (current + 1) % SHOWCASE_USE_CASES.length);
      }
    }, STORY_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [motionEnabled, product, stories.length, storyIndex]);

  return (
    <section
      aria-label={`Animated ${activeProduct.name} product preview`}
      className={`prototype-shell pointer-events-none select-none overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_30px_75px_-38px_rgba(15,23,42,0.48)] sm:p-3 ${className}`}
    >
      <span className="sr-only">
        Genosyn running a {activeUseCase.role} use case in {activeProduct.name}.
      </span>

      <div aria-hidden className="flex min-w-0 items-center gap-2 px-1 pb-2 pt-0.5 sm:px-2 sm:pb-3">
        <LogoMark className="h-7 w-7 shrink-0 text-slate-900" />
        <span className="h-4 w-px bg-slate-200" />
        <div className="min-w-0">
          <div className="truncate text-[10px] font-semibold text-slate-800">
            Northstar Labs
          </div>
          <div className="truncate text-[9px] text-slate-400">Company workspace</div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1.5">
          <span className="prototype-live-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-emerald-700">
            Live
          </span>
        </div>
      </div>

      <div
        aria-hidden
        className="grid overflow-hidden rounded-xl border border-slate-200 bg-slate-50 lg:grid-cols-[11.5rem_minmax(0,1fr)]"
      >
        <PrototypeSidebar useCase={activeUseCase} activeProduct={activeProduct} />

        <div className="min-w-0 overflow-hidden bg-[#f8fafc]">
          <div className="flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-3.5 sm:px-4">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${activeProduct.accent}`}
            >
              <ActiveIcon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-slate-950">
                {activeProduct.name}
              </div>
              <div className="truncate text-[9px] text-slate-500">{activeUseCase.role}</div>
            </div>
            <div className="ml-auto hidden items-center gap-1.5 text-[9px] font-medium text-slate-400 sm:flex">
              <LockKeyhole className="h-3 w-3" />
              Approval gates on
            </div>
            <span className="hidden h-4 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-1.5 text-[9px] font-semibold tabular text-slate-500">
              <Clock3 className="h-3 w-3" />
              08:42
            </div>
          </div>

          <div
            key={`${activeProduct.slug}-${showcaseIndex}`}
            className={`prototype-stage relative overflow-hidden ${compact ? "prototype-stage-compact" : ""}`}
          >
            {Preview && <Preview />}

            {story && (
              <div
                key={`${activeProduct.slug}-${storyIndex}`}
                className="prototype-activity absolute bottom-3 left-3 right-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_16px_38px_-18px_rgba(24,24,27,0.45)] sm:left-auto sm:max-w-[22rem]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold text-slate-950">
                    {story.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] text-slate-500 sm:text-[10px]">
                    {story.detail}
                  </span>
                </span>
                <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 border-t border-slate-200 bg-white">
            {stories.map((candidate, index) => (
              <div
                key={candidate.label}
                className={`relative min-w-0 px-2.5 py-2.5 sm:px-3 ${
                  index === storyIndex ? "bg-slate-50 text-slate-950" : "text-slate-400"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold ${
                      index < storyIndex
                        ? "bg-emerald-100 text-emerald-700"
                        : index === storyIndex
                          ? "bg-slate-950 text-white"
                          : "bg-slate-100 text-slate-400"
                    }`}
                  >
                    {index < storyIndex ? <Check className="h-2.5 w-2.5" /> : index + 1}
                  </span>
                  <span className="truncate text-[9px] font-semibold sm:text-[10px]">
                    {candidate.label}
                  </span>
                </span>
                {index === storyIndex && motionEnabled && (
                  <span className="prototype-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-slate-900" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PrototypeSidebar({
  useCase,
  activeProduct,
}: {
  useCase: ProductUseCase;
  activeProduct: ProductDef;
}) {
  return (
    <aside className="hidden min-w-0 border-r border-slate-200 bg-slate-50 p-3 lg:flex lg:flex-col">
      <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-400">
        Employee on duty
      </div>
      <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold ring-1 ${useCase.accent}`}
        >
          {useCase.initials}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[10px] font-semibold text-slate-900">{useCase.role}</div>
          <div className="mt-0.5 truncate text-[9px] text-slate-400">{useCase.team}</div>
        </div>
      </div>

      <div className="mt-5 text-[9px] font-bold uppercase tracking-[0.18em] text-slate-400">
        Working set
      </div>
      <div className="mt-2 space-y-1">
        {useCase.productSlugs.slice(0, 4).map((slug) => {
          const candidate = PRODUCTS.find((item) => item.slug === slug);
          if (!candidate) return null;
          const Icon = productIcon(candidate.icon);
          const active = candidate.slug === activeProduct.slug;
          return (
            <div
              key={slug}
              className={`flex items-center gap-2 rounded-lg px-2 py-2 text-[10px] font-medium ${
                active ? "bg-slate-100 text-slate-800" : "text-slate-500"
              }`}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{candidate.name}</span>
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-slate-900" />}
            </div>
          );
        })}
      </div>

      <div className="mt-auto rounded-xl border border-slate-200 bg-slate-100/70 p-2.5">
        <div className="flex items-center gap-2 text-[9px] font-semibold text-slate-800">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
          Run policy
        </div>
        <div className="mt-1.5 text-[9px] leading-4 text-slate-500">
          Act inside Grants. Ask before sensitive changes.
        </div>
      </div>
    </aside>
  );
}
