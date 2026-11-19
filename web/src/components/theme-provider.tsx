import { useLayoutEffect } from "react"
import { useResolvedTheme } from "@/hooks/use-theme"
import { applyTheme } from "@/lib/theme"

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const resolved = useResolvedTheme()

  useLayoutEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  return <>{children}</>
}
