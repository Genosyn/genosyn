import { Logo } from "@/components/Logo";

/** Keep the launch screen visible while the Member's session is loading. */
export function SplashScreen() {
  return (
    <div
      data-app-splash
      className="fixed inset-0 flex items-center justify-center bg-black px-8 text-white"
      role="status"
      aria-label="Loading Genosyn"
    >
      <Logo className="h-auto w-60 max-w-full" />
    </div>
  );
}
