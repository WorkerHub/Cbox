import { cn } from "@/lib/utils"

type SiteLogoProps = {
  className?: string
}

export function SiteLogo({ className }: SiteLogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0", className)}
    >
      <path
        fillRule="evenodd"
        d="M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5Z M12 8.6 15.4 12 12 15.4 8.6 12 12 8.6Z"
      />
    </svg>
  )
}
