import { CheckIcon, CopyIcon, LinkIcon, Trash2Icon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { sharesApi } from "@/lib/api"
import { describeApiError } from "@/lib/api-errors"
import type { FileItem, ShareItem } from "@/lib/api-types"
import { formatDateTime, isExpired } from "@/lib/format"

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: FileItem | null
}

const ALL_SHARE_PRESETS = ["file", "1h", "24h", "7d", "never"] as const

export function ShareDialog({ open, onOpenChange, file }: ShareDialogProps) {
  const { t } = useTranslation()
  const [shares, setShares] = useState<ShareItem[]>([])
  const [loadingShares, setLoadingShares] = useState(false)
  const [expiresIn, setExpiresIn] = useState<string>("file")
  const [createdUrl, setCreatedUrl] = useState<string>("")
  const [generating, setGenerating] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [copiedSha, setCopiedSha] = useState(false)
  const [error, setError] = useState("")

  const fileHasExpiration = Boolean(file?.expiresAt)

  useEffect(() => {
    if (!file) return
    setExpiresIn("file")
  }, [file])

  useEffect(() => {
    if (!open || !file) {
      setShares([])
      setCreatedUrl("")
      setError("")
      setCopiedUrl(null)
      setCopiedSha(false)
      return
    }

    let active = true
    setLoadingShares(true)
    sharesApi
      .list(file.id)
      .then((res) => {
        if (active) setShares(res.items)
      })
      .catch((err) => {
        if (active) setError(describeApiError(t, err))
      })
      .finally(() => {
        if (active) setLoadingShares(false)
      })

    return () => {
      active = false
    }
  }, [open, file, t])

  if (!file) return null

  const handleCopy = async (text: string, type: "link" | "sha") => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === "link") {
        setCopiedUrl(text)
        setTimeout(
          () => setCopiedUrl((curr) => (curr === text ? null : curr)),
          2000
        )
      } else {
        setCopiedSha(true)
        setTimeout(() => setCopiedSha(false), 2000)
      }
      toast.success(t("workbench.actions.copied"))
    } catch {
      toast.error(t("errors.generic"))
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError("")
    setCreatedUrl("")
    try {
      const result = await sharesApi.create(file.id, expiresIn)
      setCreatedUrl(result.url)

      const updated = await sharesApi.list(file.id)
      setShares(updated.items)
    } catch (err) {
      setError(describeApiError(t, err))
      toast.error(describeApiError(t, err))
    } finally {
      setGenerating(false)
    }
  }

  const handleRevoke = async (shareId: string) => {
    try {
      await sharesApi.delete(shareId)
      setShares((prev) => prev.filter((s) => s.id !== shareId))
      toast.success(t("workbench.shareDialog.revoked"))
    } catch (err) {
      toast.error(describeApiError(t, err))
    }
  }

  const allowedPresets = fileHasExpiration
    ? ALL_SHARE_PRESETS.filter((p) => p !== "never")
    : ALL_SHARE_PRESETS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workbench.shareDialog.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-xs">
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center justify-between font-medium text-foreground">
              <span className="truncate pr-2">{file.name}</span>
              {file.expiresAt && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {isExpired(file.expiresAt)
                    ? t("workbench.status.expired")
                    : formatDateTime(file.expiresAt)}
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-muted-foreground">
                {t("workbench.shareDialog.sha256")}
              </span>
              {file.sha256 ? (
                <div className="flex items-center gap-1.5 font-mono">
                  <span className="max-w-[180px] truncate sm:max-w-[260px]">
                    {file.sha256}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleCopy(file.sha256!, "sha")}
                    title={t("workbench.shareDialog.copySha256")}
                  >
                    {copiedSha ? (
                      <CheckIcon className="h-3 w-3 text-green-600" />
                    ) : (
                      <CopyIcon className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <label className="text-muted-foreground sm:w-20">
                {t("workbench.shareDialog.expiration")}
              </label>
              <div className="flex flex-1 items-center gap-2">
                <Select value={expiresIn} onValueChange={setExpiresIn}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowedPresets.map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        {t(`workbench.presets.${preset}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  onClick={handleGenerate}
                  disabled={generating || isExpired(file.expiresAt)}
                >
                  {t("workbench.shareDialog.generate")}
                </Button>
              </div>
            </div>

            {fileHasExpiration && (
              <p className="text-[11px] text-muted-foreground">
                {t("workbench.presets.cappedAt")}
              </p>
            )}

            {createdUrl && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
                <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  readOnly
                  value={createdUrl}
                  className="h-7 border-0 bg-transparent px-0 font-mono text-xs focus-visible:ring-0"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => handleCopy(createdUrl, "link")}
                >
                  {copiedUrl === createdUrl ? (
                    <CheckIcon className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <CopyIcon className="h-3.5 w-3.5" />
                  )}
                  {t("workbench.shareDialog.copyLink")}
                </Button>
              </div>
            )}
          </div>

          {error && <p className="text-destructive">{error}</p>}

          <Separator />
          <div className="flex flex-col gap-2">
            <div className="font-medium text-foreground">
              {t("workbench.shareDialog.existingShares")}
            </div>

            {loadingShares ? (
              <div className="py-2 text-center text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : shares.length === 0 ? (
              <div className="py-2 text-center text-muted-foreground">
                {t("workbench.shareDialog.noExisting")}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 divide-y divide-border/40">
                {shares.map((share) => {
                  const shareUrl = share.token
                    ? `${window.location.origin}/s/${share.token}`
                    : null

                  return (
                    <div
                      key={share.id}
                      className="flex flex-col gap-1.5 pt-2 text-xs"
                    >
                      {shareUrl ? (
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
                            onClick={() => handleCopy(shareUrl, "link")}
                          >
                            {copiedUrl === shareUrl ? (
                              <CheckIcon className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <CopyIcon className="h-3.5 w-3.5" />
                            )}
                            {t("workbench.shareDialog.copyLink")}
                          </Button>
                        </div>
                      ) : null}

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          {share.expired && (
                            <Badge
                              variant="destructive"
                              className="text-[10px]"
                            >
                              {t("workbench.status.expired")}
                            </Badge>
                          )}
                          <span>
                            {share.expiresAt
                              ? formatDateTime(share.expiresAt)
                              : t("workbench.status.never")}
                          </span>
                          <span>•</span>
                          <span>
                            {t("workbench.shareDialog.downloads", {
                              count: share.downloadCount
                            })}
                          </span>
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleRevoke(share.id)}
                          className="text-destructive hover:bg-destructive/10"
                          title={t("workbench.actions.revoke")}
                        >
                          <Trash2Icon className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
