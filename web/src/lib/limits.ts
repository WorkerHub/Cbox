/**
 * 限额常数与换算工具（规格 §4）
 * 1 MB = 1048576 字节，上限 1048576 MB（1 TiB）。
 * 前后端口径完全一致。
 */

export const BYTES_PER_MB = 1048576
export const MAX_LIMIT_MB = 1048576

export function mbToBytes(mb: number): number {
  return Math.floor(mb * BYTES_PER_MB)
}

export function bytesToMB(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_MB)
}

/**
 * 校验 MB 输入：必须为 1 ~ 1048576 之间的正整数。
 */
export function validateLimitMB(value: unknown): {
  valid: boolean
  num?: number
  errorKey?: string
} {
  if (value === undefined || value === null || value === "") {
    return { valid: false, errorKey: "admin.limits.errors.required" }
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT_MB) {
    return { valid: false, errorKey: "admin.limits.errors.invalidRange" }
  }
  return { valid: true, num: n }
}
