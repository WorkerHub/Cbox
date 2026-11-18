import { filesTable } from "../../lib/tables"
import type { FileRow } from "./files"

export interface PendingUploadRow extends FileRow {
  status: "pending" | "active"
  upload_id: string | null
}

export interface InsertPendingFileInput {
  id: string
  userId: number
  folderId: string | null
  name: string
  sizeBytes: number
  contentType: string
  sha256: string | null
  r2Key: string
  uploadId: string | null
  expiresAt: string | null
}

/**
 * 插入处于 pending 状态的文件记录，预占用户配额。
 */
export async function insertPendingFileRecord(
  db: D1Database,
  prefix: string,
  input: InsertPendingFileInput
): Promise<PendingUploadRow> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${filesTable(prefix)}
        (id, user_id, folder_id, name, size_bytes, content_type,
         sha256, r2_key, status, upload_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .bind(
      input.id,
      input.userId,
      input.folderId,
      input.name,
      input.sizeBytes,
      input.contentType,
      input.sha256,
      input.r2Key,
      input.uploadId,
      input.expiresAt,
      now
    )
    .run()

  return {
    id: input.id,
    user_id: input.userId,
    folder_id: input.folderId,
    name: input.name,
    size_bytes: input.sizeBytes,
    content_type: input.contentType,
    sha256: input.sha256,
    r2_key: input.r2Key,
    status: "pending",
    upload_id: input.uploadId,
    expires_at: input.expiresAt,
    created_at: now
  }
}

/**
 * 根据文件 ID 与用户 ID 查询待完成的直传任务。
 */
export async function findPendingUploadById(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string
): Promise<PendingUploadRow | null> {
  return await db
    .prepare(
      `SELECT id, user_id, folder_id, name, size_bytes, content_type,
              sha256, r2_key, status, upload_id, expires_at, created_at
         FROM ${filesTable(prefix)}
        WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .bind(fileId, userId)
    .first<PendingUploadRow>()
}

export interface CompleteFileUploadUpdates {
  sizeBytes?: number
  sha256?: string | null
}

/**
 * 完成直传：将状态由 'pending' 推进为 'active'，清空 upload_id。
 */
export async function completeFileUpload(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string,
  updates?: CompleteFileUploadUpdates
): Promise<boolean> {
  const params: unknown[] = []
  let extraSql = ""

  if (updates?.sizeBytes !== undefined) {
    extraSql += ", size_bytes = ?"
    params.push(updates.sizeBytes)
  }
  if (updates?.sha256 !== undefined) {
    extraSql += ", sha256 = ?"
    params.push(updates.sha256)
  }

  params.push(fileId, userId)

  const result = await db
    .prepare(
      `UPDATE ${filesTable(prefix)}
          SET status = 'active',
              upload_id = NULL
              ${extraSql}
        WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .bind(...params)
    .run()

  return result.meta.changes > 0
}

/**
 * 删除 pending 状态的文件记录（用于客户端主动中止或超时兜底清理）。
 */
export async function deletePendingUpload(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ${filesTable(prefix)}
        WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .bind(fileId, userId)
    .run()

  return result.meta.changes > 0
}

/**
 * 查询超过指定时间的陈旧 pending 上传记录（用于定时任务清理）。
 */
export async function listStalePendingUploads(
  db: D1Database,
  prefix: string,
  olderThanIso: string
): Promise<PendingUploadRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, user_id, folder_id, name, size_bytes, content_type,
              sha256, r2_key, status, upload_id, expires_at, created_at
         FROM ${filesTable(prefix)}
        WHERE status = 'pending' AND created_at < ?`
    )
    .bind(olderThanIso)
    .all<PendingUploadRow>()

  return rows.results
}
