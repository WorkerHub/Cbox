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
import { Input } from "@/components/ui/input"
import { foldersApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"

interface CreateFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentFolderId: string | null
  onSuccess: () => void
}

export function CreateFolderDialog({
  open,
  onOpenChange,
  currentFolderId,
  onSuccess
}: CreateFolderDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName("")
      setError("")
      setBusy(false)
    }
    onOpenChange(nextOpen)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return

    setBusy(true)
    setError("")

    try {
      await foldersApi.create({
        parentId: currentFolderId,
        name: trimmed
      })
      handleOpenChange(false)
      onSuccess()
    } catch (err) {
      setError(describeApiError(t, err))
      toast.error(describeApiError(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workbench.folderDialog.title")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("workbench.folderDialog.placeholder")}
            disabled={busy}
          />
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
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy
                ? t("common.actions.saving")
                : t("workbench.folderDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
