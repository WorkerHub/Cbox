import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { filesApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { FileItem } from "@/lib/api-types"

interface RenameFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: FileItem | null
  onSuccess: () => void
}

export function RenameFileDialog({
  open,
  onOpenChange,
  file,
  onSuccess
}: RenameFileDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const selectBaseName = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const val = el.value
    const lastDot = val.lastIndexOf(".")
    const end = lastDot > 0 ? lastDot : val.length
    el.focus()
    el.setSelectionRange(0, end)
  }, [])

  useEffect(() => {
    if (open && file) {
      setName(file.name)
      setError("")
    }
  }, [open, file])

  useEffect(() => {
    if (open && file && name === file.name) {
      selectBaseName()
    }
  }, [open, file, name, selectBaseName])

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
    if (!file) return

    const trimmed = name.trim()
    if (!trimmed) return

    if (trimmed === file.name) {
      handleOpenChange(false)
      return
    }

    setBusy(true)
    setError("")

    try {
      await filesApi.patch(file.id, { name: trimmed })
      handleOpenChange(false)
      onSuccess()
    } catch (err) {
      setError(describeApiError(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          selectBaseName()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("workbench.renameDialog.title")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            ref={(node) => {
              inputRef.current = node
              if (node) {
                node.select = () => {
                  const val = node.value
                  const lastDot = val.lastIndexOf(".")
                  const end = lastDot > 0 ? lastDot : val.length
                  node.setSelectionRange(0, end)
                }
              }
            }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("workbench.renameDialog.placeholder")}
            disabled={busy}
            data-testid="rename-file-input"
          />
          {error && (
            <p className="text-xs text-destructive" data-testid="rename-error">
              {error}
            </p>
          )}
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
                : t("workbench.renameDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
