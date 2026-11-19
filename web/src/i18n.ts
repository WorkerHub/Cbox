import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import {
  DEFAULT_LANGUAGE,
  detectBrowserLanguage,
  isLanguage,
  type Language,
  readStoredLanguage,
  SUPPORTED_LANGUAGES,
  writeStoredLanguage
} from "@/lib/language"
import en from "@/locales/en.json"
import zh from "@/locales/zh.json"

function initialLanguage(): Language {
  return readStoredLanguage() ?? detectBrowserLanguage()
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en }
  },
  lng: initialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  react: { useSuspense: false }
})

function applyDocumentLanguage(language: string) {
  if (typeof document === "undefined") return
  document.documentElement.lang = isLanguage(language)
    ? language
    : DEFAULT_LANGUAGE
}

i18n.on("languageChanged", applyDocumentLanguage)
applyDocumentLanguage(i18n.language)

export function currentLanguage(): Language {
  const value = i18n.resolvedLanguage ?? i18n.language
  return isLanguage(value) ? value : DEFAULT_LANGUAGE
}

export async function changeLanguage(
  language: Language,
  options: { persist?: boolean } = {}
): Promise<void> {
  if (!isLanguage(language)) return
  if (options.persist !== false) writeStoredLanguage(language)
  if (currentLanguage() === language) return
  await i18n.changeLanguage(language)
}

export async function applyAccountLanguage(value: unknown): Promise<void> {
  if (!isLanguage(value)) return
  await changeLanguage(value)
}

export { i18n }
export default i18n
