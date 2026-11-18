import { useRef, useState } from "react"
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
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { filesApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import { calculateFileSha256 } from "@/lib/crypto"
import { formatBytes } from "@/lib/format"

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentFolderId: string | null
  onSuccess: () => void
}

const PRESET_OPTIONS = ["never", "1h", "24h", "7d", "30d"] as const

export function UploadDialog({
  open,
  onOpenChange,
  currentFolderId,
  onSuccess
}: UploadDialogProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [expiresIn, setExpiresIn] = useState<string>("never")
  const [percent, setPercent] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [error, setError] = useState("")

  const handleOpenChange = (nextOpen: boolean) => {
    if (busy) return
    if (!nextOpen) {
      setSelectedFile(null)
      setExpiresIn("never")
      setPercent(0)
      setBusy(false)
      setCalculating(false)
      setError("")
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
    onOpenChange(nextOpen)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setError("")
    setPercent(0)
  }

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedFile) return

    setBusy(true)
    setError("")
    setPercent(0)

    try {
      setCalculating(true)
      const sha256 = await calculateFileSha256(selectedFile)
      setCalculating(false)

      await filesApi.upload(
        selectedFile,
        {
          folderId: currentFolderId,
          expiresIn: expiresIn === "never" ? null : expiresIn,
          sha256
        },
        (progressPercent) => {
          setPercent(progressPercent)
        }
      )

      handleOpenChange(false)
      onSuccess()
    } catch (err) {
      setCalculating(false)
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
          <DialogTitle>{t("workbench.uploadDialog.title")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleUpload} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              disabled={busy}
              className="file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:opacity-90 block w-full text-xs text-muted-foreground"
            />
            {selectedFile && (
              <div className="text-xs text-muted-foreground">
                {selectedFile.name} ({formatBytes(selectedFile.size)})
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">
              {t("workbench.uploadDialog.expiration")}
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

          {busy && (
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {calculating
                    ? t("workbench.uploadDialog.calculating")
                    : t("workbench.uploadDialog.progress", { percent })}
                </span>
                <span>{percent}%</span>
              </div>
              <Progress value={percent} className="h-2" />
            </div>
          )}

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
            <Button type="submit" disabled={busy || !selectedFile}>
              {busy
                ? t("common.actions.saving")
                : t("workbench.uploadDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
