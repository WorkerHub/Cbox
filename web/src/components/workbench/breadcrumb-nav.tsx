import { ChevronRightIcon, FolderIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { BreadcrumbItem } from "@/lib/api-types"

interface BreadcrumbNavProps {
  breadcrumbs: BreadcrumbItem[]
  onSelect: (folderId: string | null) => void
}

export function BreadcrumbNav({ breadcrumbs, onSelect }: BreadcrumbNavProps) {
  const { t } = useTranslation()

  if (breadcrumbs.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <FolderIcon className="h-4 w-4 text-muted-foreground" />
        <span>{t("workbench.root")}</span>
      </div>
    )
  }

  return (
    <nav className="flex items-center gap-1 overflow-x-auto text-sm">
      {breadcrumbs.map((crumb, idx) => {
        const isLast = idx === breadcrumbs.length - 1
        const label =
          crumb.id === null && (!crumb.name || crumb.name === "Root")
            ? t("workbench.root")
            : crumb.name

        return (
          <div key={crumb.id ?? "root"} className="flex items-center gap-1">
            {idx > 0 && (
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            )}
            {isLast ? (
              <span className="font-semibold text-foreground whitespace-nowrap">
                {label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(crumb.id)}
                className="text-muted-foreground hover:text-foreground whitespace-nowrap transition-colors"
              >
                {label}
              </button>
            )}
          </div>
        )
      })}
    </nav>
  )
}
