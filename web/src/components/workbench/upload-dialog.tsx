import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react"
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
import { Input } from "@/components/ui/input"
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
  const [uploadedBytes, setUploadedBytes] = useState<number>(0)
  const [totalBytes, setTotalBytes] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [error, setError] = useState("")
  const [completedShare, setCompletedShare] = useState<{
    token: string
    expiresAt: string | null
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const abortControllerRef = useRef<AbortController | null>(null)

  const shareUrl = completedShare
    ? `${window.location.origin}/s/${completedShare.token}`
    : ""

  const resetState = () => {
    setSelectedFile(null)
    setExpiresIn("never")
    setPercent(0)
    setUploadedBytes(0)
    setTotalBytes(0)
    setBusy(false)
    setCalculating(false)
    setError("")
    setCompletedShare(null)
    setCopied(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    resetState()
    onOpenChange(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (busy) {
        handleCancel()
        return
      }
      const completed = completedShare !== null
      resetState()
      if (completed) {
        onSuccess()
      }
    }
    onOpenChange(nextOpen)
  }

  const handleCopy = async () => {
    if (!completedShare) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast.success(t("workbench.actions.copied"))
    } catch {
      toast.error(t("errors.generic"))
    }
  }

  const handleDone = () => {
    resetState()
    onOpenChange(false)
    onSuccess()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setSelectedFile(file)
    setError("")
    setPercent(0)
    setUploadedBytes(0)
    setTotalBytes(file?.size ?? 0)
  }

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedFile) return

    setBusy(true)
    setError("")
    setPercent(0)
    setUploadedBytes(0)
    setTotalBytes(selectedFile.size)

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      setCalculating(true)
      const sha256 = await calculateFileSha256(selectedFile, {
        signal: controller.signal
      })
      if (controller.signal.aborted) {
        return
      }
      setCalculating(false)

      const result = await filesApi.upload(
        selectedFile,
        {
          folderId: currentFolderId,
          expiresIn: expiresIn === "never" ? null : expiresIn,
          sha256,
          signal: controller.signal
        },
        (progress) => {
          setUploadedBytes(progress.loaded)
          setTotalBytes(progress.total)
          setPercent(progress.percent)
        }
      )

      if (result.share) {
        setCompletedShare(result.share)
      } else {
        resetState()
        onOpenChange(false)
        onSuccess()
      }
    } catch (err: unknown) {
      setCalculating(false)
      if (
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return
      }
      const msg = describeApiError(t, err)
      setError(msg)
      toast.error(msg)
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workbench.uploadDialog.title")}</DialogTitle>
        </DialogHeader>

        {completedShare ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
              <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                readOnly
                value={shareUrl}
                className="h-7 border-0 bg-transparent px-0 font-mono text-xs focus-visible:ring-0"
              />
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={handleCopy}
              >
                {copied ? (
                  <CheckIcon className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
                {t("workbench.shareDialog.copyLink")}
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={handleDone}>
                {t("workbench.uploadDialog.done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
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
                      : t("workbench.uploadDialog.progressBytes", {
                          uploaded: formatBytes(uploadedBytes),
                          total: formatBytes(totalBytes)
                        })}
                  </span>
                  <span>{percent}%</span>
                </div>
                <Progress value={percent} className="h-2" />
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCancel}>
                {t("common.actions.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !selectedFile}>
                {busy
                  ? t("common.actions.saving")
                  : t("workbench.uploadDialog.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
