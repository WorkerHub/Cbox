import { create } from "zustand"
import type { PublicInfo } from "@/lib/api-types"
import { publicApi } from "@/lib/api"

interface SiteState {
  info: PublicInfo | null
  loaded: boolean
  load: () => Promise<PublicInfo | null>
}

export const useSiteStore = create<SiteState>((set) => ({
  info: null,
  loaded: false,

  load: async () => {
    try {
      const info = await publicApi.get()
      set({ info, loaded: true })
      return info
    } catch {
      set({ loaded: true })
      return null
    }
  }
}))
