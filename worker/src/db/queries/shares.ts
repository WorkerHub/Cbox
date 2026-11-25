import { sha256Hex } from "../../core/auth"
import { filesTable, sharesTable } from "../../lib/tables"
import { calculateExpiresAt, isFileExpired } from "./files"

export interface ShareRow {
  id: string
  file_id: string
  user_id: number
  token: string | null
  token_hash: string
  expires_at: string | null
  download_count: number
  last_downloaded_at: string | null
  created_at: string
}

export interface ShareView {
  id: string
  fileId: string
  token: string | null
  expiresAt: string | null
  downloadCount: number
  lastDownloadedAt: string | null
  createdAt: string
  expired: boolean
}

export interface CreateShareResult {
  id: string
  token: string
  tokenSuffix: string
  expiresAt: string | null
}

const SHARE_TOKEN_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/**
 * 生成 8 位无偏高熵随机字符串（字符集 [A-Za-z0-9]，约 48 位熵）。
 * 使用 crypto.getRandomValues + 拒绝采样，拒绝 byte >= 248（62 * 4），避免简单取模偏差。
 */
export function generateShareToken(length = 8): string {
  const maxValidByte = 248 // 62 * 4 = 248 (0..247 有效)
  let token = ""

  while (token.length < length) {
    const needed = length - token.length
    const buffer = new Uint8Array(needed + 8)
    crypto.getRandomValues(buffer)
    for (let i = 0; i < buffer.length && token.length < length; i++) {
      const byte = buffer[i]
      if (byte < maxValidByte) {
        token += SHARE_TOKEN_CHARS[byte % 62]
      }
    }
  }

  return token
}

/**
 * 为文件创建公开分享（规格 §1、§2、§3）：
 * - 令牌：8 位字符 [A-Za-z0-9]（无偏拒绝采样），D1 存明文与 SHA-256 哈希；
 * - 遇到 token_hash 唯一约束冲突时重新生成并重试，最多 3 次，仍冲突则报错；
 * - 失效预设：file / 1h / 24h / 7d / never（默认 file，跟随文件到期时间）；
 * - 其余预设受文件 expires_at 封顶截断。
 */
export async function createShareRecord(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string,
  preset: string = "file"
): Promise<CreateShareResult | null> {
  // 1. 查询文件
  const file = await db
    .prepare(
      `SELECT id, user_id, expires_at
         FROM ${filesTable(prefix)}
        WHERE id = ? AND user_id = ? AND status = 'active'`
    )
    .bind(fileId, userId)
    .first<{ id: string; user_id: number; expires_at: string | null }>()

  if (!file) return null
  if (isFileExpired(file.expires_at)) return null

  // 2. 计算分享失效时间，受文件 expires_at 封顶
  let shareExpiresAt: string | null
  if (preset === "file") {
    shareExpiresAt = file.expires_at
  } else {
    shareExpiresAt = calculateExpiresAt(preset)
    if (file.expires_at !== null) {
      if (shareExpiresAt === null || shareExpiresAt > file.expires_at) {
        shareExpiresAt = file.expires_at
      }
    }
  }

  // 3. 生成令牌与哈希（唯一冲突重试最多 3 次）
  const MAX_RETRIES = 3

  for (let attempt = 0; ; attempt++) {
    const token = generateShareToken()
    const tokenHash = await sha256Hex(token)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    try {
      await db
        .prepare(
          `INSERT INTO ${sharesTable(prefix)}
            (id, file_id, user_id, token, token_hash, expires_at, download_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .bind(id, fileId, userId, token, tokenHash, shareExpiresAt, now)
        .run()

      return {
        id,
        token,
        tokenSuffix: tokenHash.slice(-4),
        expiresAt: shareExpiresAt
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null && "message" in err
            ? String((err as any).message)
            : String(err)
      const isConflict = /unique/i.test(message) || /constraint/i.test(message)
      if (!isConflict || attempt >= MAX_RETRIES) {
        throw err
      }
    }
  }
}

export async function listSharesByFile(
  db: D1Database,
  prefix: string,
  userId: number,
  fileId: string
): Promise<ShareView[]> {
  const rows = await db
    .prepare(
      `SELECT id, file_id, token, token_hash, expires_at, download_count,
              last_downloaded_at, created_at
         FROM ${sharesTable(prefix)}
        WHERE file_id = ? AND user_id = ?
        ORDER BY created_at DESC, rowid DESC`
    )
    .bind(fileId, userId)
    .all<ShareRow>()

  const now = new Date().toISOString()
  return rows.results.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    token: r.token ?? null,
    expiresAt: r.expires_at,
    downloadCount: r.download_count,
    lastDownloadedAt: r.last_downloaded_at,
    createdAt: r.created_at,
    expired: isFileExpired(r.expires_at, now)
  }))
}

export async function deleteShareRecord(
  db: D1Database,
  prefix: string,
  userId: number,
  shareId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM ${sharesTable(prefix)}
        WHERE id = ? AND user_id = ?`
    )
    .bind(shareId, userId)
    .run()

  return result.meta.changes > 0
}

export interface ShareWithFile {
  shareId: string
  shareExpiresAt: string | null
  fileId: string
  fileName: string
  fileSizeBytes: number
  contentType: string
  sha256: string | null
  r2Key: string
  fileExpiresAt: string | null
}

/**
 * 根据令牌哈希查询有效分享（联查文件）：
 * 供 GET /s/:token 免登直链端点使用。
 */
export async function findActiveShareByToken(
  db: D1Database,
  prefix: string,
  token: string
): Promise<ShareWithFile | null> {
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT s.id AS share_id,
              s.expires_at AS share_expires_at,
              f.id AS file_id,
              f.name AS file_name,
              f.size_bytes AS file_size_bytes,
              f.content_type AS content_type,
              f.sha256 AS sha256,
              f.r2_key AS r2_key,
              f.expires_at AS file_expires_at
         FROM ${sharesTable(prefix)} s
         JOIN ${filesTable(prefix)} f ON s.file_id = f.id
        WHERE s.token_hash = ? AND f.status = 'active'`
    )
    .bind(tokenHash)
    .first<{
      share_id: string
      share_expires_at: string | null
      file_id: string
      file_name: string
      file_size_bytes: number
      content_type: string
      sha256: string | null
      r2_key: string
      file_expires_at: string | null
    }>()

  if (!row) return null

  const now = new Date().toISOString()
  if (isFileExpired(row.share_expires_at, now)) return null
  if (isFileExpired(row.file_expires_at, now)) return null

  return {
    shareId: row.share_id,
    shareExpiresAt: row.share_expires_at,
    fileId: row.file_id,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    contentType: row.content_type,
    sha256: row.sha256,
    r2Key: row.r2_key,
    fileExpiresAt: row.file_expires_at
  }
}

export async function incrementShareDownload(
  db: D1Database,
  prefix: string,
  shareId: string
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE ${sharesTable(prefix)}
          SET download_count = download_count + 1,
              last_downloaded_at = ?
        WHERE id = ?`
    )
    .bind(now, shareId)
    .run()
}
