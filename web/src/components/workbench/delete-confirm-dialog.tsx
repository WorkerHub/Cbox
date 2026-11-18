import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { filesApi, foldersApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { FileItem, FolderItem } from "@/lib/api-types"

export type DeleteTarget =
  | { type: "file"; item: FileItem }
  | { type: "folder"; item: FolderItem }
  | null

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DeleteTarget
  onSuccess: () => void
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  target,
  onSuccess
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  if (!target) return null

  const isFolder = target.type === "folder"
  const title = isFolder
    ? t("workbench.deleteDialog.deleteFolderTitle")
    : t("workbench.deleteDialog.deleteFileTitle")
  const description = isFolder
    ? t("workbench.deleteDialog.deleteFolderDesc")
    : t("workbench.deleteDialog.deleteFileDesc")

  const handleConfirm = async () => {
    setBusy(true)
    try {
      if (isFolder) {
        await foldersApi.delete(target.item.id)
      } else {
        await filesApi.delete(target.item.id)
      }
      onOpenChange(false)
      onSuccess()
    } catch (err) {
      toast.error(describeApiError(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="pt-2 text-xs leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive">
          {target.item.name}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy
              ? t("common.actions.saving")
              : t("workbench.deleteDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
