import { LanguagesIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { changeLanguage } from "@/i18n"
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  SUPPORTED_LANGUAGES
} from "@/lib/language"

interface LanguagePickerProps {
  onChange?: (language: Language) => void
}

function useLanguageChoice(onChange?: (language: Language) => void) {
  const { i18n } = useTranslation()
  const value = i18n.resolvedLanguage ?? i18n.language
  const current = isLanguage(value) ? value : DEFAULT_LANGUAGE
  return {
    current,
    select: (next: Language) => {
      if (next === current) return
      if (onChange) {
        void changeLanguage(next)
        onChange(next)
      } else {
        void changeLanguage(next)
      }
    }
  }
}

export function LanguageCycleButton({ onChange }: LanguagePickerProps) {
  const { t } = useTranslation()
  const { current, select } = useLanguageChoice(onChange)
  const label = t("common.languages.switch", {
    language: t(`common.languages.${current}`)
  })

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={() => {
        const index = SUPPORTED_LANGUAGES.indexOf(current)
        select(SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length])
      }}
    >
      <LanguagesIcon aria-hidden="true" />
    </Button>
  )
}
