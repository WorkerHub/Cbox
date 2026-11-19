export type Theme = "auto" | "light" | "dark"

export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "app-theme"

export const THEME_OPTIONS: { value: Theme; labelKey: string }[] = [
  { value: "auto", labelKey: "common.theme.auto" },
  { value: "light", labelKey: "common.theme.light" },
  { value: "dark", labelKey: "common.theme.dark" }
]

export function isTheme(value: unknown): value is Theme {
  return value === "auto" || value === "light" || value === "dark"
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function resolveTheme(
  theme: Theme,
  systemDark = systemPrefersDark()
): ResolvedTheme {
  if (theme === "auto") return systemDark ? "dark" : "light"
  return theme
}

export function applyTheme(resolved: ResolvedTheme): ResolvedTheme {
  if (typeof document === "undefined") return resolved
  const dark = resolved === "dark"
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", dark ? "#0a0a0a" : "#ffffff")
  return resolved
}

export function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return null
    let candidate: unknown = raw
    try {
      const parsed = JSON.parse(raw) as { state?: { theme?: unknown } }
      candidate = parsed?.state?.theme ?? raw
    } catch {
      candidate = raw
    }
    return isTheme(candidate) ? candidate : null
  } catch {
    return null
  }
}

export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
