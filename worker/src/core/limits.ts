import { filesTable, settingsTable, userLimitsTable } from "../lib/tables"

export const DEFAULT_FILE_QUOTA_BYTES = 104857600 // 100 MiB
export const DEFAULT_FILE_SINGLE_MAX_BYTES = 104857600 // 100 MiB
export const PLATFORM_HARD_CAP_BYTES = 104857600 // 100 MiB (Cloudflare request body cap)
export const BYTES_PER_MB = 1048576
export const MAX_LIMIT_MB = 1048576 // 1 TiB

export interface UserLimitsResolution {
  globalQuotaBytes: number
  globalSingleMaxBytes: number
  userQuotaBytes: number | null
  userSingleMaxBytes: number | null
  effectiveQuotaBytes: number
  effectiveSingleMaxBytes: number
}

export function mbToBytes(mb: number): number {
  return Math.floor(mb * BYTES_PER_MB)
}

export function bytesToMB(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_MB)
}

/**
 * 解析用户的生效限额（规格 §4）：
 * - 单人覆盖优先；
 * - 逐项独立回落到全局配置（system_settings），缺失时回落硬编码默认值 100 MiB；
 * - 生效单文件上限与平台硬顶（约 100 MiB）取小，执行实际上限。
 */
export async function resolveUserLimits(
  db: D1Database,
  prefix: string,
  userId: number
): Promise<UserLimitsResolution> {
  const settingsRows = await db
    .prepare(
      `SELECT key, value FROM ${settingsTable(prefix)}
        WHERE key IN ('file_quota_default_bytes', 'file_single_max_default_bytes')`
    )
    .all<{ key: string; value: string }>()

  let globalQuotaBytes = DEFAULT_FILE_QUOTA_BYTES
  let globalSingleMaxBytes = DEFAULT_FILE_SINGLE_MAX_BYTES

  for (const row of settingsRows.results) {
    const val = Number(row.value)
    if (Number.isInteger(val) && val > 0) {
      if (row.key === "file_quota_default_bytes") globalQuotaBytes = val
      else if (row.key === "file_single_max_default_bytes")
        globalSingleMaxBytes = val
    }
  }

  const userLimitRow = await db
    .prepare(
      `SELECT quota_bytes, single_max_bytes FROM ${userLimitsTable(prefix)}
        WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      quota_bytes: number | null
      single_max_bytes: number | null
    }>()

  const userQuotaBytes =
    userLimitRow?.quota_bytes != null &&
    Number.isInteger(userLimitRow.quota_bytes)
      ? userLimitRow.quota_bytes
      : null
  const userSingleMaxBytes =
    userLimitRow?.single_max_bytes != null &&
    Number.isInteger(userLimitRow.single_max_bytes)
      ? userLimitRow.single_max_bytes
      : null

  const effectiveQuotaBytes = userQuotaBytes ?? globalQuotaBytes
  const rawSingleMaxBytes = userSingleMaxBytes ?? globalSingleMaxBytes
  const effectiveSingleMaxBytes = Math.min(
    rawSingleMaxBytes,
    PLATFORM_HARD_CAP_BYTES
  )

  return {
    globalQuotaBytes,
    globalSingleMaxBytes,
    userQuotaBytes,
    userSingleMaxBytes,
    effectiveQuotaBytes,
    effectiveSingleMaxBytes
  }
}

/**
 * 计算用户当前已用容量（字节数）：
 * 以 D1 中现存未过期文件的 size_bytes 之和为准（删除/过期即释放）。
 */
export async function getUserUsageBytes(
  db: D1Database,
  prefix: string,
  userId: number,
  nowIso?: string
): Promise<number> {
  const currentIso = nowIso ?? new Date().toISOString()
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total
         FROM ${filesTable(prefix)}
        WHERE user_id = ?
          AND (expires_at IS NULL OR expires_at > ?)`
    )
    .bind(userId, currentIso)
    .first<{ total: number }>()

  return Number(row?.total ?? 0)
}

export type LimitValidationResult =
  | { ok: true }
  | {
      ok: false
      code: "FILE_TOO_LARGE" | "QUOTA_EXCEEDED"
      error: string
      limitBytes: number
    }

/**
 * 服务端上传限额校验（规格 §4 硬规则，一处实现）：
 * 校验顺序：①单文件大小 ≤ 生效单文件上限；②当前已用容量 + 文件大小 ≤ 生效总容量。
 * 任一不过拒绝并回稳定错误码，错误文案如实回显实际上限。
 */
export function validateUploadLimits(
  limits: { effectiveSingleMaxBytes: number; effectiveQuotaBytes: number },
  currentUsageBytes: number,
  incomingBytes: number
): LimitValidationResult {
  if (incomingBytes > limits.effectiveSingleMaxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      error: `File size exceeds the maximum allowed limit of ${limits.effectiveSingleMaxBytes} bytes`,
      limitBytes: limits.effectiveSingleMaxBytes
    }
  }

  if (currentUsageBytes + incomingBytes > limits.effectiveQuotaBytes) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      error: `Storage quota exceeded. Allowed quota: ${limits.effectiveQuotaBytes} bytes, current usage: ${currentUsageBytes} bytes`,
      limitBytes: limits.effectiveQuotaBytes
    }
  }

  return { ok: true }
}
