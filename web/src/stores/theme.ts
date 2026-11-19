import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { readStoredTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme"

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: readStoredTheme() ?? "auto",
      setTheme: (theme) => set({ theme })
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme })
    }
  )
)
