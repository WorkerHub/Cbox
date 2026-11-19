export const SUPPORTED_LANGUAGES = ["zh", "en"] as const

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: Language = "zh"

export const LANGUAGE_STORAGE_KEY = "app-language"

export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  )
}

export function detectBrowserLanguage(
  navigatorLanguage = typeof navigator === "undefined" ? "" : navigator.language
): Language {
  return navigatorLanguage.toLowerCase().startsWith("en")
    ? "en"
    : DEFAULT_LANGUAGE
}

export function readStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

export function writeStoredLanguage(language: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {}
}

export function intlLocale(language: Language): string {
  return language === "en" ? "en-US" : "zh-CN"
}
