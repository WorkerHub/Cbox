/**
 * 容量与时间格式化小工具。
 * 纯数字与单位拼接，不含写死的中文字面量，满足 copy.test.ts 守卫。
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB", "TB"]
  const k = 1024
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    units.length - 1
  )

  const value = bytes / k ** i
  // 小数位数：如果是整字节或大于 100 则保留 0 或 1 位小数
  const formatted =
    i === 0
      ? value.toFixed(0)
      : value >= 100
        ? value.toFixed(0)
        : value.toFixed(1)

  return `${formatted.replace(/\.0$/, "")} ${units[i]}`
}

export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "-"
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return "-"

  const pad = (n: number) => n.toString().padStart(2, "0")
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

export function isExpired(
  expiresAt: string | null | undefined,
  now = Date.now()
): boolean {
  if (!expiresAt) return false
  const time = new Date(expiresAt).getTime()
  if (Number.isNaN(time)) return false
  return time <= now
}
