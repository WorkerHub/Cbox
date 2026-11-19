export const SIDEBAR_WIDTH_STORAGE_KEY = "app-sidebar-width"
export const SIDEBAR_OPEN_STORAGE_KEY = "app-sidebar-open"

export const SIDEBAR_WIDTH_DEFAULT = 240
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 360

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(width))
  )
}

export function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_WIDTH_DEFAULT
    return clampSidebarWidth(parsed)
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function writeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarWidth(width))
    )
  } catch {}
}

export function writeSidebarOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
  } catch {}
}
