import { Logo } from "@/components/Logo";

/**
 * Keep the launch screen visible while the Member's session is loading. It
 * uses the app background with a soft logo so loading blends into the first
 * screen; index.html and scripts/icons/generate-splash.ts use the same colors.
 */
export function SplashScreen() {
  return (
    <div
      data-app-splash
      className="fixed inset-0 flex items-center justify-center bg-slate-50 px-8 text-slate-400 dark:bg-slate-900 dark:text-slate-600"
      role="status"
      aria-label="Loading Genosyn"
    >
      <Logo className="h-auto w-60 max-w-full" />
    </div>
  );
}
