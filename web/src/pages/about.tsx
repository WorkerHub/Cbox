import { ExternalLinkIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  buildInfo,
  buildTimeZoneLabel,
  formatBuildDate,
  formatBuildTime
} from "@/lib/build-info"
import { useSiteStore } from "@/stores/site"

export function AboutPage() {
  const { t } = useTranslation()
  const info = useSiteStore((state) => state.info)

  const stack = [
    ["about.stackFrontend", "about.stackFrontendValue"],
    ["about.stackBackend", "about.stackBackendValue"],
    ["about.stackUi", "about.stackUiValue"],
    ["about.stackI18n", "about.stackI18nValue"]
  ] as const

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="space-y-2 rounded-xl border bg-card p-4 text-sm">
        <h2 className="font-heading text-base font-semibold">{info?.name}</h2>
        {info?.repositoryUrl ? (
          <a
            href={info.repositoryUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            {info.repositoryUrl}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="font-heading text-sm font-semibold">
          {t("about.stack")}
        </h2>
        <dl className="space-y-2 text-sm">
          {stack.map(([labelKey, valueKey]) => (
            <div
              key={labelKey}
              className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3"
            >
              <dt className="text-xs font-medium text-muted-foreground">
                {t(labelKey)}
              </dt>
              <dd>{t(valueKey)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4 text-sm">
        <h2 className="font-heading text-sm font-semibold">
          {t("about.buildInfo")}
        </h2>
        <dl className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-3">
          <dt className="text-xs font-medium text-muted-foreground">
            {t("about.version")}
          </dt>
          <dd className="font-mono text-xs break-all">{buildInfo.version}</dd>

          <dt className="text-xs font-medium text-muted-foreground">
            {t("about.buildDate")}
          </dt>
          <dd>{formatBuildDate()}</dd>

          <dt className="text-xs font-medium text-muted-foreground">
            {t("about.buildTime")}
          </dt>
          <dd>
            {formatBuildTime()}{" "}
            <span className="text-xs text-muted-foreground">
              {buildTimeZoneLabel()}
            </span>
          </dd>
        </dl>
      </section>
    </div>
  )
}
