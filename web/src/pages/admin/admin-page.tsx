import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useOutletContext,
  useSearchParams
} from "react-router"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { AdminSettings } from "@/lib/api-types"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CreateUserSection } from "@/pages/admin/create-user-section"
import { UsersSection } from "@/pages/admin/users-section"

export interface AdminOutletContext {
  settings: AdminSettings
  onSaved: (settings: AdminSettings) => void
}

/** 用户管理子路由视图：包含新建用户与用户列表（文件限额透传给用户限额弹窗）。 */
export function AdminUsersTab() {
  const { settings } = useOutletContext<AdminOutletContext>()
  return (
    <div className="space-y-4">
      <CreateUserSection />
      <UsersSection globalLimits={settings.fileLimits} />
    </div>
  )
}

/**
 * 旧 `/admin?tab=<slug>` 链接的兼容重定向：
 * - `maintenance` 映射到 `/admin/database`（历史别名）；
 * - 其余非空 slug 直通 `/admin/<slug>`；
 * - 缺省/空则回落到首 tab `/admin/email`。
 */
export function AdminIndexRedirect() {
  const [searchParams] = useSearchParams()
  const tab = searchParams.get("tab")
  const target = !tab
    ? "/admin/email"
    : tab === "maintenance"
      ? "/admin/database"
      : `/admin/${tab}`
  return <Navigate to={target} replace />
}

/**
 * 系统管理页（规格 §6.1，仅管理员）：邮件配置、注册/审核、用户列表、
 * 文件限额、setup 页开关与数据库维护。菜单隐藏只是体验，接口层 403 才是边界。
 * 现已重构为路径段独立子路由，不使用 query 参数或页内状态切换。
 */
export function AdminPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setError("")
    try {
      setSettings(await adminApi.settings())
    } catch (loadError) {
      setError(describeApiError(t, loadError))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const segments = location.pathname.split("/").filter(Boolean)
  const currentTab =
    segments[1] === "database" ? "maintenance" : segments[1] || "email"

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!settings && !error ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : null}

      {settings ? (
        <Tabs value={currentTab}>
          <TabsList>
            <TabsTrigger value="email" asChild>
              <NavLink to="/admin/email">{t("admin.tabs.email")}</NavLink>
            </TabsTrigger>
            <TabsTrigger value="registration" asChild>
              <NavLink to="/admin/registration">
                {t("admin.tabs.registration")}
              </NavLink>
            </TabsTrigger>
            <TabsTrigger value="users" asChild>
              <NavLink to="/admin/users">{t("admin.tabs.users")}</NavLink>
            </TabsTrigger>
            <TabsTrigger value="limits" asChild>
              <NavLink to="/admin/limits">{t("admin.tabs.limits")}</NavLink>
            </TabsTrigger>
            <TabsTrigger value="maintenance" asChild>
              <NavLink to="/admin/database">
                {t("admin.tabs.maintenance")}
              </NavLink>
            </TabsTrigger>
          </TabsList>

          <div className="pt-4">
            <Outlet
              context={
                {
                  settings,
                  onSaved: setSettings
                } satisfies AdminOutletContext
              }
            />
          </div>
        </Tabs>
      ) : null}
    </div>
  )
}
