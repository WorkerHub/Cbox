import { cn } from "cn"
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
  const isCritical = percent >= 90

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 p-3 w-full sm:max-w-md"
      data-testid="usage-bar"
    >
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground shrink-0">
          {t("workbench.usage.label")}
        </span>
        <div className="flex items-baseline gap-1.5 flex-wrap justify-end text-muted-foreground">
          <span>
            {t("workbench.usage.detail", {
              used: formatBytes(usedBytes),
              total: formatBytes(quotaBytes)
            })}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-[11px] text-muted-foreground/75">
            {t("workbench.usage.singleMax", {
              size: formatBytes(singleMaxBytes)
            })}
          </span>
        </div>
      </div>
      <Progress
        value={percent}
        className={cn("h-2", isCritical && "bg-destructive/20")}
        indicatorClassName={isCritical ? "bg-destructive" : undefined}
      />
    </div>
  )
}
