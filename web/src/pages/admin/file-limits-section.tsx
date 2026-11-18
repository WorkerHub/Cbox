import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useOutletContext } from "react-router"
import { toast } from "sonner"
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { AdminSettings } from "@/lib/api-types"
import { validateLimitMB } from "@/lib/limits"

/**
 * 系统管理 · 文件限额（规格 §4、§7）。
 * 全局默认总容量与单文件上限配置（填多少生效多少，无平台硬顶钳制）。
 */
export function FileLimitsSection(props?: {
  settings?: AdminSettings
  onSaved?: (settings: AdminSettings) => void
}) {
  const { t } = useTranslation()
  const outlet = useOutletContext<{
    settings: AdminSettings
    onSaved: (settings: AdminSettings) => void
  } | null>()
  const settings = props?.settings ?? outlet?.settings
  const onSaved = props?.onSaved ?? outlet?.onSaved ?? (() => {})

  const limits = settings?.fileLimits

  const [defaultQuotaMB, setDefaultQuotaMB] = useState(
    String(limits?.defaultQuotaMB ?? 100)
  )
  const [defaultSingleMaxMB, setDefaultSingleMaxMB] = useState(
    String(limits?.defaultSingleMaxMB ?? 100)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!settings) return
    setDefaultQuotaMB(String(settings.fileLimits.defaultQuotaMB ?? 100))
    setDefaultSingleMaxMB(String(settings.fileLimits.defaultSingleMaxMB ?? 100))
  }, [settings])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    const quotaVal = validateLimitMB(defaultQuotaMB)
    if (!quotaVal.valid || quotaVal.num === undefined) {
      const msg = t(quotaVal.errorKey ?? "admin.limits.errors.invalidRange")
      setError(msg)
      toast.error(msg)
      return
    }

    const singleVal = validateLimitMB(defaultSingleMaxMB)
    if (!singleVal.valid || singleVal.num === undefined) {
      const msg = t(singleVal.errorKey ?? "admin.limits.errors.invalidRange")
      setError(msg)
      toast.error(msg)
      return
    }

    setBusy(true)
    try {
      const updated = await adminApi.updateSettings({
        fileLimits: {
          defaultQuotaMB: quotaVal.num,
          defaultSingleMaxMB: singleVal.num
        }
      })
      onSaved(updated)
      setDefaultQuotaMB(String(updated.fileLimits.defaultQuotaMB))
      setDefaultSingleMaxMB(String(updated.fileLimits.defaultSingleMaxMB))
      toast.success(t("admin.limits.saved"))
    } catch (saveError) {
      const msg = describeApiError(t, saveError)
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  if (!settings) return null

  const isDirty =
    defaultQuotaMB !== String(settings.fileLimits.defaultQuotaMB ?? 100) ||
    defaultSingleMaxMB !== String(settings.fileLimits.defaultSingleMaxMB ?? 100)

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <UnsavedChangesGuard isDirty={isDirty} />
      <div className="space-y-1">
        <h3 className="font-heading text-sm font-semibold">
          {t("admin.limits.title")}
        </h3>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} noValidate className="space-y-4 max-w-md">
        <div className="space-y-1.5">
          <Label htmlFor="default-quota-mb">
            {t("admin.limits.defaultQuotaMB")}
          </Label>
          <Input
            id="default-quota-mb"
            type="number"
            min={1}
            max={1048576}
            step={1}
            value={defaultQuotaMB}
            onChange={(e) => setDefaultQuotaMB(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="default-single-max-mb">
            {t("admin.limits.defaultSingleMaxMB")}
          </Label>
          <Input
            id="default-single-max-mb"
            type="number"
            min={1}
            max={1048576}
            step={1}
            value={defaultSingleMaxMB}
            onChange={(e) => setDefaultSingleMaxMB(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t("admin.limits.saving") : t("admin.limits.save")}
        </Button>
      </form>
    </section>
  )
}
