import { ArrowRight, Github, ShieldCheck } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";
import { CompanyPreview } from "@/sections/CompanyPreview";
import {
  HeroActions,
  HeroBadge,
  HeroBadgeDot,
  HeroButton,
  HeroCopy,
  HeroGrid,
  HeroLede,
  HeroPanel,
  HeroProof,
  HeroSection,
  HeroTitle,
  HeroTitleMuted,
} from "@/sections/HeroKit";

const PROOF = ["MIT licensed", "Self-hosted", "Any AI model", "Human approvals"];

export function Hero() {
  return (
    <HeroSection>
      <HeroGrid>
        <HeroCopy>
          <HeroBadge href={GITHUB_URL} external>
            Open source · Self-hosted
            <HeroBadgeDot />
            <span className="font-medium text-slate-500">v{__APP_VERSION__}</span>
            <ArrowRight aria-hidden className="h-3.5 w-3.5" />
          </HeroBadge>

          <HeroTitle>
            Put people and AI on the{" "}
            <HeroTitleMuted>same operating system.</HeroTitleMuted>
          </HeroTitle>

          <HeroLede>
            Give AI Employees real roles, shared company context, scheduled work, and clear human
            guardrails — all in one workspace you control.
          </HeroLede>

          <HeroActions>
            <HeroButton href="#quickstart">
              Install Genosyn
              <ArrowRight aria-hidden className="h-4 w-4" />
            </HeroButton>
            <HeroButton href="#how-it-works" variant="secondary">
              See how it works
              <ArrowRight aria-hidden className="h-4 w-4 text-slate-400" />
            </HeroButton>
            <HeroButton href={GITHUB_URL} external variant="ghost">
              <Github aria-hidden className="h-4 w-4" />
              GitHub
            </HeroButton>
          </HeroActions>

          <HeroProof items={PROOF} />
        </HeroCopy>

        <HeroPanel label="Northstar Labs · Live workspace" status="Work moving now">
          <CompanyPreview compact />
          <div className="absolute -bottom-5 right-3 hidden items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-[0_18px_45px_-20px_rgba(15,23,42,0.45)] sm:flex lg:-right-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-white">
              <ShieldCheck aria-hidden className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-[11px] font-semibold text-slate-900">
                Human control stays visible
              </span>
              <span className="mt-0.5 block text-[10px] text-slate-500">
                3 changes waiting for review
              </span>
            </span>
          </div>
        </HeroPanel>
      </HeroGrid>
    </HeroSection>
  );
}
