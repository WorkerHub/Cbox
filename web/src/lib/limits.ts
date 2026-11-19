export const BYTES_PER_MB = 1048576
export const MAX_LIMIT_MB = 1048576

export function mbToBytes(mb: number): number {
  return Math.floor(mb * BYTES_PER_MB)
}

export function bytesToMB(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_MB)
}

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
