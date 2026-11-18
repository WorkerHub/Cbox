import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { filesApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { FileItem } from "@/lib/api-types"

interface EditExpirationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: FileItem | null
  onSuccess: () => void
}

const PRESET_OPTIONS = ["never", "1h", "24h", "7d", "30d"] as const

export function EditExpirationDialog({
  open,
  onOpenChange,
  file,
  onSuccess
}: EditExpirationDialogProps) {
  const { t } = useTranslation()
  const [expiresIn, setExpiresIn] = useState<string>("never")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (!file) return null

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setExpiresIn("never")
      setError("")
      setBusy(false)
    }
    onOpenChange(nextOpen)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError("")

    try {
      await filesApi.patchExpiration(file.id, expiresIn)
      toast.success(t("common.actions.save"))
      handleOpenChange(false)
      onSuccess()
    } catch (err) {
      const msg = describeApiError(t, err)
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workbench.editExpirationDialog.title")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">
              {t("workbench.editExpirationDialog.expiration")}
            </label>
            <Select
              value={expiresIn}
              onValueChange={setExpiresIn}
              disabled={busy}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESET_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {t(`workbench.presets.${opt}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? t("common.actions.saving")
                : t("workbench.editExpirationDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
