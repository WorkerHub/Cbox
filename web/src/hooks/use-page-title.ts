import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useLocation } from "react-router"
import { useSiteStore } from "@/stores/site"

export const PAGE_TITLE_KEYS: Record<string, string> = {
  "/": "common.home",
  "/login": "auth.login.title",
  "/register": "auth.register.title",
  "/forgot-password": "auth.forgot.title",
  "/change-password": "changePassword.title",
  "/setup": "setup.title",
  "/workbench": "workbench.nav.workbench",
  "/profile": "profile.title",
  "/settings": "settings.title",
  "/settings/security": "settings.title",
  "/settings/preferences": "settings.title",
  "/about": "workbench.nav.about",
  "/admin": "workbench.nav.admin",
  "/admin/email": "workbench.nav.admin",
  "/admin/registration": "workbench.nav.admin",
  "/admin/users": "workbench.nav.admin",
  "/admin/others": "workbench.nav.admin"
}

export function titleKeyFor(pathname: string): string {
  if (PAGE_TITLE_KEYS[pathname]) {
    return PAGE_TITLE_KEYS[pathname]
  }
  if (pathname.startsWith("/admin/")) {
    return "workbench.nav.admin"
  }
  if (pathname.startsWith("/settings/")) {
    return "settings.title"
  }
  return "errors.notFound"
}

export function usePageTitle(): void {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const siteName = useSiteStore((state) => state.info?.name)

  useEffect(() => {
    const page = t(titleKeyFor(pathname))
    document.title = siteName ? `${page} · ${siteName}` : page
  }, [pathname, siteName, t])
}
