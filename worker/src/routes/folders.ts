import { Hono } from "hono"
import { getUserUsageBytes, resolveUserLimits } from "../core/limits"
import {
  buildBreadcrumbs,
  checkFolderNameConflict,
  createFolder,
  deleteFolderRecursive,
  findFolderById,
  isValidFolderName,
  listSubfolders
} from "../db/queries/folders"
import { listFiles } from "../db/queries/files"
import { currentUserId } from "../lib/account"
import { apiError, readJsonBody } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const folderRoutes = new Hono<HonoEnv>()

folderRoutes.get("/", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const rawParentId = c.req.query("parentId")
  const parentId =
    rawParentId && rawParentId.trim() !== "" ? rawParentId.trim() : null

  let currentFolder = null
  if (parentId !== null) {
    currentFolder = await findFolderById(c.env.DB, prefix, userId, parentId)
    if (!currentFolder) {
      return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
    }
  }

  const [breadcrumbs, subfolders, files, limits, usedBytes] = await Promise.all(
    [
      buildBreadcrumbs(c.env.DB, prefix, userId, parentId),
      listSubfolders(c.env.DB, prefix, userId, parentId),
      listFiles(c.env.DB, prefix, userId, parentId),
      resolveUserLimits(c.env.DB, prefix, userId),
      getUserUsageBytes(c.env.DB, prefix, userId)
    ]
  )

  return c.json({
    folder: currentFolder
      ? {
          id: currentFolder.id,
          parentId: currentFolder.parent_id,
          name: currentFolder.name,
          createdAt: currentFolder.created_at
        }
      : null,
    breadcrumbs,
    folders: subfolders,
    files,
    usage: {
      usedBytes,
      quotaBytes: limits.effectiveQuotaBytes,
      singleMaxBytes: limits.effectiveSingleMaxBytes
    }
  })
})

folderRoutes.post("/", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const body = await readJsonBody<{
    parentId?: unknown
    name?: unknown
  }>(c)

  if (!body) {
    return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!isValidFolderName(name)) {
    return apiError(
      c,
      400,
      "INVALID_FOLDER_NAME",
      "Folder name must be between 1 and 255 characters and cannot contain slashes"
    )
  }

  let parentId: string | null = null
  if (typeof body.parentId === "string" && body.parentId.trim() !== "") {
    parentId = body.parentId.trim()
    const parentFolder = await findFolderById(
      c.env.DB,
      prefix,
      userId,
      parentId
    )
    if (!parentFolder) {
      return apiError(c, 404, "FOLDER_NOT_FOUND", "Parent folder not found")
    }
  }

  if (await checkFolderNameConflict(c.env.DB, prefix, userId, parentId, name)) {
    return apiError(
      c,
      409,
      "FOLDER_NAME_CONFLICT",
      "A folder with the same name already exists in this folder"
    )
  }

  const folder = await createFolder(c.env.DB, prefix, userId, {
    parentId,
    name
  })

  return c.json(folder, 201)
})

folderRoutes.delete("/:id", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const folderId = c.req.param("id")?.trim()

  if (!folderId) {
    return apiError(
      c,
      400,
      "INVALID_FOLDER_ID",
      "Root folder cannot be deleted"
    )
  }

  const folder = await findFolderById(c.env.DB, prefix, userId, folderId)
  if (!folder) {
    return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
  }

  const result = await deleteFolderRecursive(
    c.env.DB,
    prefix,
    c.env.FILES,
    userId,
    folderId
  )

  return c.json({ success: true, ...result })
})
