import raw from "../../../build-info.json"

export interface BuildInfo {
  version: string
  commit: string
  commitCount: number

  builtAt: string
  timeZone: string

  offset: string
}

export const buildInfo = raw as BuildInfo

export function versionSegments(): {
  semver: string
  commitCount: number
  commit: string
} | null {
  const parts = buildInfo.version.split("-")
  if (parts.length < 3) return null
  const semver = /^v?\d+\.\d+\.\d+/.exec(parts[0])?.[0].replace(/^v/, "")
  const commitCount = Number(parts[parts.length - 2])
  const commit = parts[parts.length - 1]
  if (!semver || !Number.isInteger(commitCount)) return null
  return { semver, commitCount, commit }
}

export function buildVersionLabel(name?: string): string {
  const segments = versionSegments()
  const version = segments
    ? `${segments.semver} · ${segments.commit}+build.${segments.commitCount}`
    : buildInfo.version
  return name ? `${name} · ${version}` : version
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: buildInfo.timeZone,
    ...options
  }).format(date)
}

export function formatBuildDate(): string {
  const date = new Date(buildInfo.builtAt)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: buildInfo.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date)
}

export function formatBuildTime(): string {
  return format(new Date(buildInfo.builtAt), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })
}

export function buildTimeZoneLabel(): string {
  return `${buildInfo.timeZone} (UTC${buildInfo.offset})`
}
