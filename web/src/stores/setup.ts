import { create } from "zustand"
import type { SetupState } from "@/lib/api-types"
import { setupApi } from "@/lib/api"

const UNKNOWN_STATE: SetupState = {
  enabled: true,
  ownerExists: false,
  tablePrefix: ""
}

interface SetupGateState {
  state: SetupState | null
  loaded: boolean
  load: () => Promise<SetupState>
  apply: (state: SetupState) => void
}

export const useSetupStore = create<SetupGateState>((set) => ({
  state: null,
  loaded: false,

  load: async () => {
    try {
      const state = await setupApi.state()
      set({ state, loaded: true })
      return state
    } catch {
      set({ state: UNKNOWN_STATE, loaded: true })
      return UNKNOWN_STATE
    }
  },

  apply: (state) => set({ state, loaded: true })
}))
