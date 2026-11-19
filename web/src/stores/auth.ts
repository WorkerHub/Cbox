import { create } from "zustand"
import { applyAccountLanguage } from "@/i18n"
import { authApi, meApi } from "@/lib/api"
import type { Me } from "@/lib/api-types"

interface AuthState {
  user: Me | null
  status: "loading" | "ready"
  load: () => Promise<Me | null>
  setUser: (user: Me | null) => void
  refresh: () => Promise<Me | null>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: "loading",

  load: async () => {
    try {
      const user = await meApi.get()
      set({ user, status: "ready" })
      await applyAccountLanguage(user.language)
      return user
    } catch {
      set({ user: null, status: "ready" })
      return null
    }
  },

  setUser: (user) => set({ user, status: "ready" }),

  refresh: async () => {
    try {
      const user = await meApi.get()
      set({ user, status: "ready" })
      return user
    } catch {
      return get().user
    }
  },

  logout: async () => {
    try {
      await authApi.logout()
    } catch {}
    set({ user: null, status: "ready" })
  }
}))
