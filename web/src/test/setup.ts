import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, vi } from "vitest"
import { i18n } from "@/i18n"

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
})

if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => false)
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn()
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn()
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn()
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

async function resetStores() {
  const [
    { useAuthStore },
    { useSetupStore },
    { useSiteStore },
    { useThemeStore }
  ] = await Promise.all([
    import("@/stores/auth"),
    import("@/stores/setup"),
    import("@/stores/site"),
    import("@/stores/theme")
  ])
  useAuthStore.setState({ user: null, status: "ready" })
  useSetupStore.setState({ state: null, loaded: false })
  useSiteStore.setState({ info: null, loaded: false })
  useThemeStore.setState({ theme: "auto" })
}

beforeEach(async () => {
  localStorage.clear()
  document.documentElement.className = ""
  document.documentElement.removeAttribute("style")
  document.documentElement.lang = "zh"
  await i18n.changeLanguage("zh")
  await resetStores()
})

afterEach(async () => {
  cleanup()
  await resetStores()
  localStorage.clear()
})
