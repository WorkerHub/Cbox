/**
 * 定时任务与清理对账服务（规格 §5.5A、§8、§9）：
 * - SCHEDULED_TASK_NAME 沿用 "noop-log-tick"（waker 侧已注册该任务名，不改名）；
 * - 原生 Cron 与 waker 回调共用 runScheduledTask，以 D1 计数表抢占防重入；
 * - 真实清理逻辑 executeCleanupJob：
 *   1. 物理删除已过期文件（R2 对象 + 分享行 + 文件行）；
 *   2. 物理删除已过期分享行；
 *   3. R2 孤儿对账：扫描 >24h 且无 D1 元数据的对象并删除；
 * - 失败只记日志下轮重试；管理面手动触发可独立调用。
 */
import { consumeCounter, ensureCountersTable } from "../core/counters"
import {
  deletePendingUpload,
  listStalePendingUploads
} from "../db/queries/uploads"
import { abortMultipartUpload, isS3Configured } from "../lib/s3"
import { filesTable, sharesTable } from "../lib/tables"
import { getTablePrefix } from "../lib/table-prefix"
import type { Env } from "../types"

/** 示例任务名：waker 侧注册沿用这个 key。 */
export const SCHEDULED_TASK_NAME = "noop-log-tick"

/** 抢占窗口（秒）：一小时内只有第一个入口真正执行。 */
const CLAIM_WINDOW_SECONDS = 60 * 60

/** 孤儿对账阈值（秒）：24 小时。 */
const ORPHAN_AGE_THRESHOLD_SECONDS = 24 * 60 * 60

export type ScheduledTrigger = "cron" | "waker" | "admin"

export interface CleanupJobResult {
  deletedFiles: number
  deletedShares: number
  deletedOrphans: number
  abortedUploads: number
}

export interface ScheduledTaskOutcome {
  ran: boolean
  reason?: "already-claimed"
}

/**
 * 真实清理与对账执行内核（规格 §9）：
 * 1. 物理删除已过期文件（expires_at ≤ now）：删 R2 对象、文件行、其全部分享行；
 * 2. 删除已过期分享行（所属文件未过期时只删分享行）；
 * 3. 孤儿对账：列 R2 中早于 24 小时的对象，比对 files.r2_key 集合，删除无元数据对应的对象（只删本 bucket 内对象）。
 */
export async function executeCleanupJob(
  env: Env,
  options: { now?: number; trigger?: ScheduledTrigger } = {}
): Promise<CleanupJobResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const nowIso = new Date(now * 1000).toISOString()
  const orphanCutoff = new Date((now - ORPHAN_AGE_THRESHOLD_SECONDS) * 1000)
  const prefix = getTablePrefix(env)

  let deletedFiles = 0
  let deletedShares = 0
  let deletedOrphans = 0
  let abortedUploads = 0

  // 1. 物理删除已过期文件
  const expiredFiles = await env.DB.prepare(
    `SELECT id, r2_key FROM ${filesTable(prefix)}
      WHERE expires_at IS NOT NULL AND expires_at <= ?`
  )
    .bind(nowIso)
    .all<{ id: string; r2_key: string }>()

  if (expiredFiles.results.length > 0) {
    const fileIds = expiredFiles.results.map((f) => f.id)
    const r2Keys = expiredFiles.results.map((f) => f.r2_key)

    // 删除 R2 对象
    try {
      await env.FILES.delete(r2Keys)
    } catch (err) {
      console.error("Cleanup: failed to delete expired R2 objects:", err)
    }

    // 级联删除 shares 与 files
    const placeholders = fileIds.map(() => "?").join(", ")
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM ${sharesTable(prefix)} WHERE file_id IN (${placeholders})`
      ).bind(...fileIds),
      env.DB.prepare(
        `DELETE FROM ${filesTable(prefix)} WHERE id IN (${placeholders})`
      ).bind(...fileIds)
    ])

    deletedFiles = fileIds.length
  }

  // 2. 删除已过期分享行（其文件尚未过期）
  const expiredSharesRes = await env.DB.prepare(
    `DELETE FROM ${sharesTable(prefix)}
      WHERE expires_at IS NOT NULL AND expires_at <= ?`
  )
    .bind(nowIso)
    .run()

  deletedShares = expiredSharesRes.meta.changes ?? 0

  // 3. R2 孤儿对账（>24h 且 D1 中无对应记录）
  try {
    let cursor: string | undefined
    do {
      const listRes: R2Objects = await env.FILES.list({
        cursor,
        limit: 500
      })

      for (const obj of listRes.objects) {
        if (obj.uploaded < orphanCutoff) {
          const row = await env.DB.prepare(
            `SELECT 1 AS found FROM ${filesTable(prefix)} WHERE r2_key = ? LIMIT 1`
          )
            .bind(obj.key)
            .first<{ found: number }>()

          if (!row) {
            // 孤儿对象：早于 24 小时且无元数据对应
            await env.FILES.delete(obj.key)
            deletedOrphans++
          }
        }
      }

      cursor = listRes.truncated ? listRes.cursor : undefined
    } while (cursor)
  } catch (err) {
    console.error("Cleanup: orphan reconciliation encountered an error:", err)
  }

  // 4. 清理超期 24 小时的 pending 上传任务
  const stalePendingCutoffIso = new Date(
    (now - ORPHAN_AGE_THRESHOLD_SECONDS) * 1000
  ).toISOString()

  try {
    const staleUploads = await listStalePendingUploads(
      env.DB,
      prefix,
      stalePendingCutoffIso
    )

    for (const upload of staleUploads) {
      if (upload.upload_id && isS3Configured(env)) {
        try {
          await abortMultipartUpload(env, upload.r2_key, upload.upload_id)
        } catch (err) {
          console.warn("Cleanup: failed to abort multipart upload:", err)
        }
      }

      try {
        await env.FILES.delete(upload.r2_key)
      } catch (err) {
        console.warn("Cleanup: failed to delete pending R2 object:", err)
      }

      await deletePendingUpload(env.DB, prefix, upload.user_id, upload.id)
      abortedUploads++
    }
  } catch (err) {
    console.error("Cleanup: stale pending uploads cleanup error:", err)
  }

  console.info(
    `Cleanup completed (trigger=${options.trigger ?? "manual"}): ${deletedFiles} files, ${deletedShares} shares, ${deletedOrphans} orphans, ${abortedUploads} aborted uploads deleted`
  )

  return {
    deletedFiles,
    deletedShares,
    deletedOrphans,
    abortedUploads
  }
}

/**
 * 跑一轮定时任务（幂等）：先用计数表抢占本轮，抢到才执行。
 * `now` 可注入，测试用它推进小时窗口而不必真等。
 */
export async function runScheduledTask(
  env: Env,
  options: { trigger: ScheduledTrigger; now?: number }
): Promise<ScheduledTaskOutcome> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const prefix = getTablePrefix(env)
  await ensureCountersTable(env.DB, prefix)

  const claim = await consumeCounter(
    env.DB,
    prefix,
    {
      action: "scheduled_tick",
      account: SCHEDULED_TASK_NAME,
      windowSeconds: CLAIM_WINDOW_SECONDS
    },
    now
  )

  if (claim.count > 1) {
    console.info(
      `scheduled: ${SCHEDULED_TASK_NAME} 本轮已被另一入口执行（trigger=${options.trigger}）`
    )
    return { ran: false, reason: "already-claimed" }
  }

  console.info(
    `scheduled: ${SCHEDULED_TASK_NAME} 执行（trigger=${options.trigger}, at=${new Date(
      now * 1000
    ).toISOString()}）`
  )

  try {
    await executeCleanupJob(env, { now, trigger: options.trigger })
  } catch (err) {
    console.error(
      "scheduled cleanup failed:",
      err instanceof Error ? err.message : String(err)
    )
  }

  return { ran: true }
}
