import { useTranslation } from "react-i18next"
import { Progress } from "@/components/ui/progress"
import { formatBytes } from "@/lib/format"

interface UsageBarProps {
  usedBytes: number
  quotaBytes: number
  singleMaxBytes: number
}

export function UsageBar({
  usedBytes,
  quotaBytes,
  singleMaxBytes
}: UsageBarProps) {
  const { t } = useTranslation()

  const percent =
    quotaBytes > 0
      ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100))
      : 0

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-col gap-1.5 sm:max-w-md">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("workbench.usage.label")}</span>
          <span>
            {t("workbench.usage.detail", {
              used: formatBytes(usedBytes),
              total: formatBytes(quotaBytes)
            })}
          </span>
        </div>
        <Progress value={percent} className="h-2" />
      </div>
      <div className="text-xs text-muted-foreground">
        {t("workbench.usage.singleMax", {
          size: formatBytes(singleMaxBytes)
        })}
      </div>
    </div>
  )
}
