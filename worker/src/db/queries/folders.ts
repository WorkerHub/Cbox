import { filesTable, foldersTable, sharesTable } from "../../lib/tables"

export interface FolderRow {
  id: string
  user_id: number
  parent_id: string | null
  name: string
  created_at: string
}

export interface BreadcrumbItem {
  id: string | null
  name: string
}

export interface FolderView {
  id: string
  parentId: string | null
  name: string
  createdAt: string
}

export function isValidFolderName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 255) return false
  if (trimmed === "." || trimmed === "..") return false
  if (/[/\\]/.test(trimmed)) return false
  return true
}

export async function findFolderById(
  db: D1Database,
  prefix: string,
  userId: number,
  folderId: string
): Promise<FolderRow | null> {
  return await db
    .prepare(
      `SELECT id, user_id, parent_id, name, created_at
         FROM ${foldersTable(prefix)}
        WHERE id = ? AND user_id = ?`
    )
    .bind(folderId, userId)
    .first<FolderRow>()
}

export async function listSubfolders(
  db: D1Database,
  prefix: string,
  userId: number,
  parentId: string | null
): Promise<FolderView[]> {
  const statement =
    parentId === null
      ? db
          .prepare(
            `SELECT id, parent_id, name, created_at
               FROM ${foldersTable(prefix)}
              WHERE user_id = ? AND parent_id IS NULL
              ORDER BY name COLLATE NOCASE ASC`
          )
          .bind(userId)
      : db
          .prepare(
            `SELECT id, parent_id, name, created_at
               FROM ${foldersTable(prefix)}
              WHERE user_id = ? AND parent_id = ?
              ORDER BY name COLLATE NOCASE ASC`
          )
          .bind(userId, parentId)

  const rows = await statement.all<FolderRow>()
  return rows.results.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    createdAt: r.created_at
  }))
}

export async function buildBreadcrumbs(
  db: D1Database,
  prefix: string,
  userId: number,
  currentFolderId: string | null
): Promise<BreadcrumbItem[]> {
  const rootItem: BreadcrumbItem = { id: null, name: "root" }
  if (!currentFolderId) {
    return [rootItem]
  }

  const crumbs: BreadcrumbItem[] = []
  let currId: string | null = currentFolderId
  const visited = new Set<string>()

  while (currId && !visited.has(currId)) {
    visited.add(currId)
    const folder = await findFolderById(db, prefix, userId, currId)
    if (!folder) break
    crumbs.unshift({ id: folder.id, name: folder.name })
    currId = folder.parent_id
  }

  return [rootItem, ...crumbs]
}

export async function checkFolderNameConflict(
  db: D1Database,
  prefix: string,
  userId: number,
  parentId: string | null,
  name: string
): Promise<boolean> {
  const statement =
    parentId === null
      ? db
          .prepare(
            `SELECT 1 AS exists_row
               FROM ${foldersTable(prefix)}
              WHERE user_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
              LIMIT 1`
          )
          .bind(userId, name)
      : db
          .prepare(
            `SELECT 1 AS exists_row
               FROM ${foldersTable(prefix)}
              WHERE user_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
              LIMIT 1`
          )
          .bind(userId, parentId, name)

  const row = await statement.first<{ exists_row: number }>()
  return row !== null
}

export async function createFolder(
  db: D1Database,
  prefix: string,
  userId: number,
  input: { parentId: string | null; name: string }
): Promise<FolderView> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const name = input.name.trim()

  await db
    .prepare(
      `INSERT INTO ${foldersTable(prefix)}
        (id, user_id, parent_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, userId, input.parentId, name, now)
    .run()

  return {
    id,
    parentId: input.parentId,
    name,
    createdAt: now
  }
}

export interface RecursiveDeleteResult {
  deletedFolders: number
  deletedFiles: number
  deletedBytes: number
}

/**
 * 递归删除文件夹及其所有子文件夹与文件（规格 §5.3）：
 * 递归收集全部子文件夹与文件，批量删除 R2 对象，清理 shares、files 与 folders 记录。
 */
export async function deleteFolderRecursive(
  db: D1Database,
  prefix: string,
  r2: R2Bucket,
  userId: number,
  folderId: string
): Promise<RecursiveDeleteResult> {
  const allFolderIds: string[] = [folderId]
  let currentLayer = [folderId]

  while (currentLayer.length > 0) {
    const placeholders = currentLayer.map(() => "?").join(", ")
    const subRows = await db
      .prepare(
        `SELECT id FROM ${foldersTable(prefix)}
          WHERE user_id = ? AND parent_id IN (${placeholders})`
      )
      .bind(userId, ...currentLayer)
      .all<{ id: string }>()

    const nextLayer = subRows.results.map((r) => r.id)
    if (nextLayer.length === 0) break
    for (const id of nextLayer) {
      allFolderIds.push(id)
    }
    currentLayer = nextLayer
  }

  // 查出这些文件夹下的所有文件
  const folderPlaceholders = allFolderIds.map(() => "?").join(", ")
  const fileRows = await db
    .prepare(
      `SELECT id, r2_key, size_bytes
         FROM ${filesTable(prefix)}
        WHERE user_id = ? AND folder_id IN (${folderPlaceholders})`
    )
    .bind(userId, ...allFolderIds)
    .all<{ id: string; r2_key: string; size_bytes: number }>()

  let deletedBytes = 0
  const fileIds = fileRows.results.map((f) => {
    deletedBytes += f.size_bytes
    return f.id
  })

  // 1. 删除 R2 对象
  const r2Keys = fileRows.results.map((f) => f.r2_key)
  if (r2Keys.length > 0) {
    await r2.delete(r2Keys)
  }

  // 2. 级联删除 shares、files、folders
  if (fileIds.length > 0) {
    const fileIdPlaceholders = fileIds.map(() => "?").join(", ")
    await db
      .prepare(
        `DELETE FROM ${sharesTable(prefix)}
          WHERE file_id IN (${fileIdPlaceholders})`
      )
      .bind(...fileIds)
      .run()

    await db
      .prepare(
        `DELETE FROM ${filesTable(prefix)}
          WHERE id IN (${fileIdPlaceholders})`
      )
      .bind(...fileIds)
      .run()
  }

  await db
    .prepare(
      `DELETE FROM ${foldersTable(prefix)}
        WHERE id IN (${folderPlaceholders})`
    )
    .bind(...allFolderIds)
    .run()

  return {
    deletedFolders: allFolderIds.length,
    deletedFiles: fileIds.length,
    deletedBytes
  }
}
