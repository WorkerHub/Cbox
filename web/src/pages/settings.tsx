import { useTranslation } from "react-i18next"
import { NavLink, Outlet, useLocation } from "react-router"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function SettingsPage() {
  const { t } = useTranslation()
  const location = useLocation()

  const segments = location.pathname.split("/").filter(Boolean)
  const currentTab = segments[1] || "security"

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Tabs value={currentTab}>
        <TabsList>
          <TabsTrigger value="security" asChild>
            <NavLink to="/settings/security">
              {t("settings.tabs.security")}
            </NavLink>
          </TabsTrigger>
          <TabsTrigger value="preferences" asChild>
            <NavLink to="/settings/preferences">
              {t("settings.tabs.preferences")}
            </NavLink>
          </TabsTrigger>
        </TabsList>

        <div className="pt-4">
          <Outlet />
        </div>
      </Tabs>
    </div>
  )
}
