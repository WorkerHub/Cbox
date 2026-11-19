import type { TFunction } from "i18next"
import { ApiError } from "@/lib/api"

export function describeApiError(t: TFunction, error: unknown): string {
  if (!(error instanceof ApiError)) return t("errors.generic")

  if (error.status === 0) return t("errors.network")

  if (error.code) {
    return t(`errors.codes.${error.code}`, {
      seconds: error.retryAfter ?? 60,
      defaultValue: t("errors.generic")
    })
  }

  if (error.status === 401) return t("errors.codes.UNAUTHORIZED")
  if (error.status === 403) return t("errors.codes.FORBIDDEN")
  return t("errors.generic")
}

export function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null
  if (error.status !== 429) return null
  const seconds = error.retryAfter
  return typeof seconds === "number" && seconds > 0 ? Math.ceil(seconds) : 60
}
