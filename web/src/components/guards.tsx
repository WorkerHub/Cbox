import { Loader2Icon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, Outlet, useLocation } from "react-router"
import { useAuthStore } from "@/stores/auth"
import { useSetupStore } from "@/stores/setup"
import { usePageTitle } from "@/hooks/use-page-title"
import { useSiteStore } from "@/stores/site"

function LoadingScreen() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2Icon
        className="size-5 animate-spin text-muted-foreground"
        aria-label={t("common.loading")}
        role="status"
      />
    </div>
  )
}

export function RootGate() {
  const location = useLocation()
  const setupState = useSetupStore((state) => state.state)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const authStatus = useAuthStore((state) => state.status)

  usePageTitle()
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      useSiteStore.getState().load(),
      useSetupStore.getState().load(),
      useAuthStore.getState().load()
    ]).then(() => {
      if (!cancelled) setBooted(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!booted || !siteLoaded || authStatus === "loading" || !setupState) {
    return <LoadingScreen />
  }

  if (
    setupState.ownerExists === false &&
    setupState.enabled &&
    location.pathname !== "/setup"
  ) {
    return <Navigate to="/setup" replace />
  }

  return <Outlet />
}

export function RequireAuth() {
  const user = useAuthStore((state) => state.user)
  const location = useLocation()
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  return <Outlet />
}

export function RequirePasswordChanged() {
  const user = useAuthStore((state) => state.user)
  const location = useLocation()
  if (user?.mustChangePassword) {
    return (
      <Navigate
        to="/change-password"
        state={{ from: location.pathname }}
        replace
      />
    )
  }
  return <Outlet />
}

export function GuestOnly() {
  const user = useAuthStore((state) => state.user)
  if (user) return <Navigate to="/workbench" replace />
  return <Outlet />
}

export function RequireAdmin() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.user)
  if (user?.role !== "admin") {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        {t("errors.codes.FORBIDDEN")}
      </div>
    )
  }
  return <Outlet />
}
