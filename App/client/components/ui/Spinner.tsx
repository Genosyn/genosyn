import { Loader2 } from "lucide-react";

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-slate-400 dark:text-slate-500" />;
}
