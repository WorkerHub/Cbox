import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { AdminSettings } from "@/lib/api-types"
import { validateLimitMB } from "@/lib/limits"

/**
 * 系统管理 · 文件限额（规格 §4、§7）。
 * 全局默认总容量与单文件上限配置；生效值以服务端返回为准（受平台硬顶限制）。
 */
export function FileLimitsSection({
  settings,
  onSaved
}: {
  settings: AdminSettings
  onSaved: (settings: AdminSettings) => void
}) {
  const { t } = useTranslation()
  const limits = settings.fileLimits

  // 生效值以服务端返回为准
  const effectiveSingle =
    limits.effectiveSingleMaxMB ?? Math.min(limits.defaultSingleMaxMB, 100)

  const [defaultQuotaMB, setDefaultQuotaMB] = useState(
    String(limits.defaultQuotaMB ?? 100)
  )
  const [defaultSingleMaxMB, setDefaultSingleMaxMB] = useState(
    String(effectiveSingle)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const eff =
      settings.fileLimits.effectiveSingleMaxMB ??
      Math.min(settings.fileLimits.defaultSingleMaxMB, 100)
    setDefaultQuotaMB(String(settings.fileLimits.defaultQuotaMB ?? 100))
    setDefaultSingleMaxMB(String(eff))
  }, [settings.fileLimits])

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
      // 生效值以服务端返回为准回显
      const eff =
        updated.fileLimits.effectiveSingleMaxMB ??
        Math.min(updated.fileLimits.defaultSingleMaxMB, 100)
      setDefaultQuotaMB(String(updated.fileLimits.defaultQuotaMB))
      setDefaultSingleMaxMB(String(eff))
      toast.success(t("admin.limits.saved"))
    } catch (saveError) {
      const msg = describeApiError(t, saveError)
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const configuredSingle = limits.defaultSingleMaxMB
  const isCapped = configuredSingle > effectiveSingle

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
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
          <p className="text-xs text-muted-foreground">
            {t("admin.limits.effectiveSingleMaxHint", {
              effective: effectiveSingle
            })}
            {isCapped ? (
              <span className="text-amber-600 dark:text-amber-400 font-medium ml-1">
                {t("admin.limits.hardCapCapped", {
                  configured: configuredSingle
                })}
              </span>
            ) : null}
          </p>
        </div>

        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t("admin.limits.saving") : t("admin.limits.save")}
        </Button>
      </form>
    </section>
  )
}
