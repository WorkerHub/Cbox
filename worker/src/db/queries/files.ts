import { filesTable, sharesTable } from "../../lib/tables"

export interface FileRow {
  id: string
  user_id: number
  folder_id: string | null
  name: string
  size_bytes: number
  content_type: string
  sha256: string | null
  r2_key: string
  expires_at: string | null
  created_at: string
}

export interface FileView {
  id: string
  folderId: string | null
  name: string
  sizeBytes: number
  contentType: string
  sha256: string | null
  expiresAt: string | null
  createdAt: string
  expired: boolean
}

export const VALID_EXPIRES_IN_PRESETS = [
  "never",
  "1h",
  "24h",
  "7d",
  "30d"
] as const

export type ExpiresInPreset = (typeof VALID_EXPIRES_IN_PRESETS)[number]

export function isValidExpiresInPreset(val: string): val is ExpiresInPreset {
  return VALID_EXPIRES_IN_PRESETS.includes(val as ExpiresInPreset)
}

/**
 * 解析过期预设（规格 §5.4）：
 * never / 空值 → null（永不过期）
 * 1h → 当前 + 1小时
 * 24h → 当前 + 24小时
 * 7d → 当前 + 7天
 * 30d → 当前 + 30天
 */
export function calculateExpiresAt(
  preset?: string | null,
  fromTime = Date.now()
): string | null {
  if (!preset || preset === "never") return null
  let seconds = 0
  switch (preset) {
    case "1h":
      seconds = 3600
      break
    case "24h":
      seconds = 86400
      break
    case "7d":
      seconds = 7 * 86400
      break
    case "30d":
      seconds = 30 * 86400
      break
    default:
      return null
  }
  return new Date(fromTime + seconds * 1000).toISOString()
}

export function isFileExpired(
  expiresAt: string | null,
  nowIso?: string
): boolean {
  if (!expiresAt) return false
  const current = nowIso ?? new Date().toISOString()
  return expiresAt <= current
}

export function toFileView(row: FileRow, nowIso?: string): FileView {
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    sizeBytes: row.size_bytes,
    contentType: row.content_type,
    sha256: row.sha256,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    expired: isFileExpired(row.expires_at, nowIso)
  }
}

export async function findFileById(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string
): Promise<FileRow | null> {
  return await db
    .prepare(
      `SELECT id, user_id, folder_id, name, size_bytes, content_type,
              sha256, r2_key, expires_at, created_at
         FROM ${filesTable(prefix)}
        WHERE id = ? AND user_id = ? AND status = 'active'`
    )
    .bind(fileId, userId)
    .first<FileRow>()
}

export async function listFiles(
  db: D1Database,
  prefix: string,
  userId: number,
  folderId: string | null
): Promise<FileView[]> {
  const statement =
    folderId === null
      ? db
          .prepare(
            `SELECT id, user_id, folder_id, name, size_bytes, content_type,
                    sha256, r2_key, expires_at, created_at
               FROM ${filesTable(prefix)}
              WHERE user_id = ? AND folder_id IS NULL AND status = 'active'
              ORDER BY name COLLATE NOCASE ASC`
          )
          .bind(userId)
      : db
          .prepare(
            `SELECT id, user_id, folder_id, name, size_bytes, content_type,
                    sha256, r2_key, expires_at, created_at
               FROM ${filesTable(prefix)}
              WHERE user_id = ? AND folder_id = ? AND status = 'active'
              ORDER BY name COLLATE NOCASE ASC`
          )
          .bind(userId, folderId)

  const rows = await statement.all<FileRow>()
  const now = new Date().toISOString()
  return rows.results.map((r) => toFileView(r, now))
}

export async function checkFileNameConflict(
  db: D1Database,
  prefix: string,
  userId: number,
  folderId: string | null,
  name: string
): Promise<boolean> {
  const statement =
    folderId === null
      ? db
          .prepare(
            `SELECT 1 AS exists_row
               FROM ${filesTable(prefix)}
              WHERE user_id = ? AND folder_id IS NULL AND status = 'active' AND name = ? COLLATE NOCASE
              LIMIT 1`
          )
          .bind(userId, name)
      : db
          .prepare(
            `SELECT 1 AS exists_row
               FROM ${filesTable(prefix)}
              WHERE user_id = ? AND folder_id = ? AND status = 'active' AND name = ? COLLATE NOCASE
              LIMIT 1`
          )
          .bind(userId, folderId, name)

  const row = await statement.first<{ exists_row: number }>()
  return row !== null
}

export interface InsertFileInput {
  id: string
  userId: number
  folderId: string | null
  name: string
  sizeBytes: number
  contentType: string
  sha256: string | null
  r2Key: string
  expiresAt: string | null
}

export async function insertFileRecord(
  db: D1Database,
  prefix: string,
  input: InsertFileInput
): Promise<FileView> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO ${filesTable(prefix)}
        (id, user_id, folder_id, name, size_bytes, content_type,
         sha256, r2_key, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      input.expiresAt,
      now
    )
    .run()

  return {
    id: input.id,
    folderId: input.folderId,
    name: input.name,
    sizeBytes: input.sizeBytes,
    contentType: input.contentType,
    sha256: input.sha256,
    expiresAt: input.expiresAt,
    createdAt: now,
    expired: false
  }
}

export async function deleteFileRecord(
  db: D1Database,
  prefix: string,
  r2: R2Bucket,
  userId: number,
  fileId: string
): Promise<boolean> {
  const file = await findFileById(db, prefix, userId, fileId)
  if (!file) return false

  // 1. 删除 R2 对象
  await r2.delete(file.r2_key)

  // 2. 删除关联 shares
  await db
    .prepare(`DELETE FROM ${sharesTable(prefix)} WHERE file_id = ?`)
    .bind(fileId)
    .run()

  // 3. 删除文件行
  const result = await db
    .prepare(`DELETE FROM ${filesTable(prefix)} WHERE id = ? AND user_id = ?`)
    .bind(fileId, userId)
    .run()

  return result.meta.changes > 0
}

export async function updateFileExpiration(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string,
  newExpiresAt: string | null
): Promise<FileRow | null> {
  const file = await findFileById(db, prefix, userId, fileId)
  if (!file) return null

  await db
    .prepare(
      `UPDATE ${filesTable(prefix)}
          SET expires_at = ?
        WHERE id = ? AND user_id = ?`
    )
    .bind(newExpiresAt, fileId, userId)
    .run()

  // 若缩短了过期时间，同步截断越过新到期时间的分享行（规格 §5.4 / §6）
  if (newExpiresAt !== null) {
    await db
      .prepare(
        `UPDATE ${sharesTable(prefix)}
            SET expires_at = ?
          WHERE file_id = ?
            AND (expires_at IS NULL OR expires_at > ?)`
      )
      .bind(newExpiresAt, fileId, newExpiresAt)
      .run()
  }

  return await findFileById(db, prefix, userId, fileId)
}
