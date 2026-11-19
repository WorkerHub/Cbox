import { useEffect, useState } from "react"
import {
  resolveTheme,
  systemPrefersDark,
  watchSystemTheme,
  type ResolvedTheme
} from "@/lib/theme"
import { useThemeStore } from "@/stores/theme"

export function useSystemDark(): boolean {
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    setSystemDark(systemPrefersDark())
    return watchSystemTheme(() => setSystemDark(systemPrefersDark()))
  }, [])

  return systemDark
}

export function useResolvedTheme(): ResolvedTheme {
  const theme = useThemeStore((state) => state.theme)
  const systemDark = useSystemDark()
  return resolveTheme(theme, systemDark)
}
