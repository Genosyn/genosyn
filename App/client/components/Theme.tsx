import React from "react";

/**
 * Theme: "light" | "dark" | "system". Persisted in localStorage under
 * `genosyn.theme`. On mount, and whenever the user toggles, we reconcile the
 * `dark` class on <html>. System mode follows `prefers-color-scheme` and
 * updates live if the OS preference changes.
 */
export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "genosyn.theme";

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyThemeToHtml(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", isDark);
}

type ThemeCtx = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  isDark: boolean;
};
const ThemeContext = React.createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => readStoredTheme());
  const [isDark, setIsDark] = React.useState<boolean>(() => {
    const t = readStoredTheme();
    return t === "dark" || (t === "system" && systemPrefersDark());
  });

  const setTheme = React.useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  // Apply + track system changes when in system mode.
  React.useEffect(() => {
    applyThemeToHtml(theme);
    setIsDark(theme === "dark" || (theme === "system" && systemPrefersDark()));
    if (theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyThemeToHtml("system");
      setIsDark(systemPrefersDark());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const value = React.useMemo(() => ({ theme, setTheme, isDark }), [theme, setTheme, isDark]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
