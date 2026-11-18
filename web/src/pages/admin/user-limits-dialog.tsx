import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type {
  AdminUser,
  FileLimitSettings,
  UserLimitsResponse
} from "@/lib/api-types"
import { validateLimitMB } from "@/lib/limits"

export interface UserLimitsDialogProps {
  user: AdminUser | null
  globalLimits?: FileLimitSettings
  onClose: () => void
  onSaved: () => void
}

export function UserLimitsDialog({
  user,
  globalLimits,
  onClose,
  onSaved
}: UserLimitsDialogProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const [quotaMB, setQuotaMB] = useState("")
  const [singleMaxMB, setSingleMaxMB] = useState("")
  const [limitsInfo, setLimitsInfo] = useState<UserLimitsResponse | null>(null)

  useEffect(() => {
    if (!user) {
      setQuotaMB("")
      setSingleMaxMB("")
      setLimitsInfo(null)
      setError("")
      return
    }

    let active = true
    setLoading(true)
    setError("")

    // 优先读取现有带出的 limits，同时异步获取最新数据
    if (user.limits) {
      setQuotaMB(user.limits.quotaMB != null ? String(user.limits.quotaMB) : "")
      setSingleMaxMB(
        user.limits.singleMaxMB != null ? String(user.limits.singleMaxMB) : ""
      )
    }

    void adminApi
      .getUserLimits(user.id)
      .then((data) => {
        if (!active) return
        setLimitsInfo(data)
        setQuotaMB(data.quotaMB != null ? String(data.quotaMB) : "")
        setSingleMaxMB(data.singleMaxMB != null ? String(data.singleMaxMB) : "")
      })
      .catch((err) => {
        if (!active) return
        setError(describeApiError(t, err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [user, t])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    setError("")

    let parsedQuota: number | null = null
    if (quotaMB.trim() !== "") {
      const qVal = validateLimitMB(quotaMB)
      if (!qVal.valid || qVal.num === undefined) {
        setError(t(qVal.errorKey ?? "admin.limits.errors.invalidRange"))
        return
      }
      parsedQuota = qVal.num
    }

    let parsedSingleMax: number | null = null
    if (singleMaxMB.trim() !== "") {
      const sVal = validateLimitMB(singleMaxMB)
      if (!sVal.valid || sVal.num === undefined) {
        setError(t(sVal.errorKey ?? "admin.limits.errors.invalidRange"))
        return
      }
      parsedSingleMax = sVal.num
    }

    setBusy(true)
    try {
      await adminApi.updateUserLimits(user.id, {
        quotaMB: parsedQuota,
        singleMaxMB: parsedSingleMax
      })
      toast.success(t("admin.users.limits.saved"))
      onSaved()
      onClose()
    } catch (saveError) {
      setError(describeApiError(t, saveError))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (!user) return
    setError("")
    setBusy(true)
    try {
      await adminApi.updateUserLimits(user.id, {
        quotaMB: null,
        singleMaxMB: null
      })
      toast.success(t("admin.users.limits.cleared"))
      onSaved()
      onClose()
    } catch (clearError) {
      setError(describeApiError(t, clearError))
    } finally {
      setBusy(false)
    }
  }

  const globalQuota = globalLimits?.defaultQuotaMB ?? 100
  const globalSingle =
    globalLimits?.effectiveSingleMaxMB ??
    globalLimits?.defaultSingleMaxMB ??
    100

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("admin.users.limits.title")}</DialogTitle>
          <DialogDescription>
            {user
              ? t("admin.users.limits.description", { email: user.email })
              : ""}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <form onSubmit={handleSave} noValidate className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="user-quota-mb">
                {t("admin.users.limits.userQuotaMB")}
              </Label>
              <Input
                id="user-quota-mb"
                type="number"
                min={1}
                max={1048576}
                step={1}
                placeholder={t("admin.users.limits.globalDefaultHint", {
                  value: globalQuota
                })}
                value={quotaMB}
                onChange={(e) => setQuotaMB(e.target.value)}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.users.limits.globalDefaultHint", {
                  value: globalQuota
                })}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="user-single-max-mb">
                {t("admin.users.limits.userSingleMaxMB")}
              </Label>
              <Input
                id="user-single-max-mb"
                type="number"
                min={1}
                max={1048576}
                step={1}
                placeholder={t("admin.users.limits.globalDefaultHint", {
                  value: globalSingle
                })}
                value={singleMaxMB}
                onChange={(e) => setSingleMaxMB(e.target.value)}
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.users.limits.globalDefaultHint", {
                  value: globalSingle
                })}
              </p>
            </div>

            {limitsInfo ? (
              <div className="rounded-lg bg-muted/50 p-2.5 text-xs text-muted-foreground">
                {t("admin.users.limits.currentEffective", {
                  quota: limitsInfo.effectiveQuotaMB,
                  singleMax: limitsInfo.effectiveSingleMaxMB
                })}
              </div>
            ) : null}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClear}
                disabled={busy}
              >
                {busy
                  ? t("admin.users.limits.clearing")
                  : t("admin.users.limits.clear")}
              </Button>
              <div className="flex items-center gap-2">
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                  >
                    {t("common.actions.cancel")}
                  </Button>
                </DialogClose>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy
                    ? t("admin.users.limits.saving")
                    : t("admin.users.limits.save")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
