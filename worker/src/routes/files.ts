import { Hono } from "hono"
import {
  getUserUsageBytes,
  resolveUserLimits,
  validateUploadLimits
} from "../core/limits"
import {
  calculateExpiresAt,
  checkFileNameConflict,
  deleteFileRecord,
  findFileById,
  isFileExpired,
  isValidExpiresInPreset,
  toFileView,
  updateFileRecord
} from "../db/queries/files"
import { findFolderById, isValidFolderName } from "../db/queries/folders"
import { createShareRecord, listSharesByFile } from "../db/queries/shares"
import {
  completeFileUpload,
  deletePendingUpload,
  findPendingUploadById,
  insertPendingFileRecord
} from "../db/queries/uploads"
import {
  abortMultipartUpload,
  assertS3Configured,
  completeMultipartUpload,
  getPresignedPartPutUrl,
  getPresignedPutUrl,
  initiateMultipartUpload,
  isS3Configured,
  type CompletedPart
} from "../lib/s3"
import { currentUserId } from "../lib/account"
import { apiError, readJsonBody } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const fileRoutes = new Hono<HonoEnv>()

const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024 // 100 MiB
const MULTIPART_PART_SIZE_BYTES = 10 * 1024 * 1024 // 10 MiB

function guessContentType(
  filename: string,
  fallback = "application/octet-stream"
): string {
  const ext = filename.split(".").pop()?.toLowerCase()
  const mimeMap: Record<string, string> = {
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    mp4: "video/mp4",
    mp3: "audio/mpeg"
  }
  return (ext && mimeMap[ext]) || fallback
}

/**
 * POST /api/files/uploads/init
 * 发起直传任务：校验限额与重名，预占配额，生成 S3 预签名直传凭证（single）或初始化分片（multipart）。
 */
fileRoutes.post("/uploads/init", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)

  const body = await readJsonBody<{
    filename?: unknown
    declaredSizeBytes?: unknown
    folderId?: unknown
    expiresIn?: unknown
    contentType?: unknown
  }>(c)

  if (!body) {
    return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")
  }

  const filename = typeof body.filename === "string" ? body.filename.trim() : ""
  if (!filename) {
    return apiError(c, 400, "INVALID_FILENAME", "Filename is required")
  }

  const declaredSizeBytes =
    typeof body.declaredSizeBytes === "number" ? body.declaredSizeBytes : NaN
  if (!Number.isInteger(declaredSizeBytes) || declaredSizeBytes < 0) {
    return apiError(
      c,
      400,
      "INVALID_SIZE",
      "declaredSizeBytes must be a non-negative integer"
    )
  }

  let folderId: string | null = null
  if (typeof body.folderId === "string" && body.folderId.trim() !== "") {
    folderId = body.folderId.trim()
    const folder = await findFolderById(c.env.DB, prefix, userId, folderId)
    if (!folder) {
      return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
    }
  }

  let expiresIn: string | null = null
  if (typeof body.expiresIn === "string" && body.expiresIn.trim() !== "") {
    const trimmed = body.expiresIn.trim()
    if (trimmed !== "never" && !isValidExpiresInPreset(trimmed)) {
      return apiError(
        c,
        400,
        "INVALID_EXPIRES_IN",
        "Invalid expiration preset (allowed: never, 1h, 24h, 7d, 30d)"
      )
    }
    expiresIn = trimmed
  }

  // 1. 检查同目录重名
  if (
    await checkFileNameConflict(c.env.DB, prefix, userId, folderId, filename)
  ) {
    return apiError(
      c,
      409,
      "FILE_NAME_CONFLICT",
      "A file with the same name already exists in this folder"
    )
  }

  // 2. 限额校验
  const limits = await resolveUserLimits(c.env.DB, prefix, userId)
  const currentUsage = await getUserUsageBytes(c.env.DB, prefix, userId)
  const check = validateUploadLimits(limits, currentUsage, declaredSizeBytes)
  if (!check.ok) {
    return apiError(c, 413, check.code, check.error, {
      limitBytes: check.limitBytes
    })
  }

  assertS3Configured(c.env)

  const fileId = crypto.randomUUID()
  const r2Key = `u${userId}/${fileId}`
  const expiresAt = calculateExpiresAt(expiresIn)
  const contentType =
    typeof body.contentType === "string" && body.contentType.trim() !== ""
      ? body.contentType.trim()
      : guessContentType(filename)

  if (declaredSizeBytes <= MULTIPART_THRESHOLD_BYTES) {
    // Single 模式
    const presignedUrl = await getPresignedPutUrl(
      c.env,
      r2Key,
      declaredSizeBytes
    )

    await insertPendingFileRecord(c.env.DB, prefix, {
      id: fileId,
      userId,
      folderId,
      name: filename,
      sizeBytes: declaredSizeBytes,
      contentType,
      sha256: null,
      r2Key,
      uploadId: null,
      expiresAt
    })

    return c.json(
      {
        uploadId: fileId,
        mode: "single",
        partSize: MULTIPART_PART_SIZE_BYTES,
        url: presignedUrl
      },
      201
    )
  } else {
    // Multipart 模式
    const s3UploadId = await initiateMultipartUpload(c.env, r2Key, contentType)

    await insertPendingFileRecord(c.env.DB, prefix, {
      id: fileId,
      userId,
      folderId,
      name: filename,
      sizeBytes: declaredSizeBytes,
      contentType,
      sha256: null,
      r2Key,
      uploadId: s3UploadId,
      expiresAt
    })

    return c.json(
      {
        uploadId: fileId,
        mode: "multipart",
        partSize: MULTIPART_PART_SIZE_BYTES
      },
      201
    )
  }
})

/**
 * POST /api/files/uploads/:id/part-urls
 * 批量签发分片上传预签名 URL（单次最多 50 个分片）。
 */
fileRoutes.post("/uploads/:id/part-urls", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const upload = await findPendingUploadById(c.env.DB, prefix, userId, fileId)
  if (!upload) {
    return apiError(
      c,
      404,
      "UPLOAD_NOT_FOUND",
      "Upload not found or already completed"
    )
  }

  if (!upload.upload_id) {
    return apiError(
      c,
      400,
      "INVALID_UPLOAD_MODE",
      "Single upload does not support part URLs"
    )
  }

  const body = await readJsonBody<{ partNumbers?: unknown }>(c)
  if (!body || !Array.isArray(body.partNumbers)) {
    return apiError(c, 400, "INVALID_REQUEST", "partNumbers array is required")
  }

  const partNumbers = body.partNumbers
  if (
    partNumbers.length < 1 ||
    partNumbers.length > 50 ||
    partNumbers.some(
      (p) => typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 10000
    )
  ) {
    return apiError(
      c,
      400,
      "INVALID_PART_NUMBERS",
      "partNumbers must contain between 1 and 50 integer part numbers (1-10000)"
    )
  }

  assertS3Configured(c.env)

  const parts = await Promise.all(
    partNumbers.map(async (partNumber) => {
      const url = await getPresignedPartPutUrl(
        c.env,
        upload.r2_key,
        upload.upload_id!,
        partNumber
      )
      return { partNumber, url }
    })
  )

  return c.json({ parts })
})

/**
 * POST /api/files/uploads/:id/complete
 * 完成直传：合并分片（若为 multipart）、HEAD 校验实际大小、复核限额并激活记录。
 */
fileRoutes.post("/uploads/:id/complete", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const upload = await findPendingUploadById(c.env.DB, prefix, userId, fileId)
  if (!upload) {
    return apiError(
      c,
      404,
      "UPLOAD_NOT_FOUND",
      "Upload not found or already completed"
    )
  }

  const body =
    (await readJsonBody<{
      sha256?: unknown
      parts?: unknown
    }>(c)) ?? {}

  const sha256 =
    typeof body.sha256 === "string" && body.sha256.trim() !== ""
      ? body.sha256.trim()
      : null

  if (upload.upload_id) {
    // Multipart 模式：合并分片
    if (
      !Array.isArray(body.parts) ||
      body.parts.length === 0 ||
      body.parts.some(
        (p: any) =>
          !p ||
          typeof p.partNumber !== "number" ||
          !Number.isInteger(p.partNumber) ||
          typeof p.etag !== "string" ||
          !p.etag.trim()
      )
    ) {
      return apiError(
        c,
        400,
        "INVALID_PARTS",
        "parts array with partNumber and etag is required for multipart completion"
      )
    }

    assertS3Configured(c.env)

    try {
      await completeMultipartUpload(
        c.env,
        upload.r2_key,
        upload.upload_id,
        body.parts as CompletedPart[]
      )
    } catch (err) {
      console.error("Complete multipart upload error:", err)
      return apiError(
        c,
        500,
        "COMPLETE_FAILED",
        "Failed to complete multipart upload on storage"
      )
    }
  }

  // 统一通过 FILES.head 校验对象实际大小
  const head = await c.env.FILES.head(upload.r2_key)
  if (!head) {
    return apiError(
      c,
      400,
      "OBJECT_NOT_FOUND",
      "Uploaded object not found in storage"
    )
  }

  const actualSizeBytes = head.size

  // 限额复核
  const limits = await resolveUserLimits(c.env.DB, prefix, userId)
  if (actualSizeBytes > limits.effectiveSingleMaxBytes) {
    await c.env.FILES.delete(upload.r2_key)
    await deletePendingUpload(c.env.DB, prefix, userId, fileId)
    return apiError(
      c,
      413,
      "FILE_TOO_LARGE",
      "File exceeds single file size limit",
      {
        limitBytes: limits.effectiveSingleMaxBytes
      }
    )
  }

  const currentUsage = await getUserUsageBytes(c.env.DB, prefix, userId)
  const adjustedUsage = currentUsage - upload.size_bytes + actualSizeBytes
  if (adjustedUsage > limits.effectiveQuotaBytes) {
    await c.env.FILES.delete(upload.r2_key)
    await deletePendingUpload(c.env.DB, prefix, userId, fileId)
    return apiError(c, 413, "QUOTA_EXCEEDED", "Storage quota exceeded", {
      limitBytes: limits.effectiveQuotaBytes
    })
  }

  // 校验通过，原子转为 active 状态
  await completeFileUpload(c.env.DB, prefix, userId, fileId, {
    sizeBytes: actualSizeBytes,
    sha256
  })

  const file = await findFileById(c.env.DB, prefix, userId, fileId)
  if (!file) {
    return apiError(
      c,
      500,
      "FILE_ACTIVATE_FAILED",
      "Failed to activate file record"
    )
  }

  const fileView = toFileView(file)

  // 自动创建分享（跟随文件有效期，明文令牌仅此一次；失败不阻塞上传成功）
  try {
    const autoShare = await createShareRecord(
      c.env.DB,
      prefix,
      userId,
      fileId,
      "file"
    )
    if (autoShare) {
      fileView.share = {
        token: autoShare.token,
        expiresAt: autoShare.expiresAt
      }
    }
  } catch (err) {
    console.error("Auto share creation on complete failed:", err)
  }

  return c.json(fileView, 200)
})

/**
 * DELETE /api/files/uploads/:id
 * 中止并清理直传任务：中止分片、删除对象、删除 pending 记录即时释放预占配额。
 */
fileRoutes.delete("/uploads/:id", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const upload = await findPendingUploadById(c.env.DB, prefix, userId, fileId)
  if (!upload) {
    return apiError(
      c,
      404,
      "UPLOAD_NOT_FOUND",
      "Upload not found or already completed"
    )
  }

  if (upload.upload_id && isS3Configured(c.env)) {
    try {
      await abortMultipartUpload(c.env, upload.r2_key, upload.upload_id)
    } catch (err) {
      console.warn("Failed to abort multipart upload in storage:", err)
    }
  }

  await c.env.FILES.delete(upload.r2_key)
  await deletePendingUpload(c.env.DB, prefix, userId, fileId)

  return c.json({ success: true })
})

fileRoutes.get("/:id/download", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const file = await findFileById(c.env.DB, prefix, userId, fileId)
  if (!file) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  if (isFileExpired(file.expires_at)) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  const r2Object = await c.env.FILES.get(file.r2_key)
  if (!r2Object?.body) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File object missing in storage")
  }

  const encodedFilename = encodeURIComponent(file.name)
  const headers = new Headers({
    "Content-Type": file.content_type || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    "Content-Length": file.size_bytes.toString(),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache"
  })

  return new Response(r2Object.body, {
    status: 200,
    headers
  })
})

fileRoutes.delete("/:id", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const deleted = await deleteFileRecord(
    c.env.DB,
    prefix,
    c.env.FILES,
    userId,
    fileId
  )
  if (!deleted) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  return c.json({ success: true })
})

fileRoutes.patch("/:id", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  if (!fileId) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  const body = await readJsonBody<{
    name?: unknown
    folderId?: unknown
    expiresIn?: unknown
  }>(c)
  if (!body) {
    return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")
  }

  const hasName = body.name !== undefined
  const hasFolderId = body.folderId !== undefined
  const hasExpiresIn = body.expiresIn !== undefined

  if (!hasName && !hasFolderId && !hasExpiresIn) {
    return apiError(
      c,
      400,
      "INVALID_REQUEST",
      "At least one field (name, folderId, expiresIn) is required"
    )
  }

  const file = await findFileById(c.env.DB, prefix, userId, fileId)
  if (!file) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  let targetFolderId: string | null = file.folder_id
  if (hasFolderId) {
    if (body.folderId === null) {
      targetFolderId = null
    } else if (typeof body.folderId === "string") {
      const trimmedFolderId = body.folderId.trim()
      if (!trimmedFolderId) {
        return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
      }
      const folder = await findFolderById(
        c.env.DB,
        prefix,
        userId,
        trimmedFolderId
      )
      if (!folder) {
        return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
      }
      targetFolderId = trimmedFolderId
    } else {
      return apiError(
        c,
        400,
        "INVALID_REQUEST",
        "folderId must be a string or null"
      )
    }
  }

  let targetName = file.name
  if (hasName) {
    if (typeof body.name !== "string" || !isValidFolderName(body.name)) {
      return apiError(
        c,
        400,
        "INVALID_FILENAME",
        "File name must be between 1 and 255 characters and cannot contain slashes"
      )
    }
    targetName = body.name.trim()
  }

  if (hasName || hasFolderId) {
    const isConflict = await checkFileNameConflict(
      c.env.DB,
      prefix,
      userId,
      targetFolderId,
      targetName,
      file.id
    )
    if (isConflict) {
      return apiError(
        c,
        409,
        "FILE_NAME_CONFLICT",
        "A file with the same name already exists in this folder"
      )
    }
  }

  let newExpiresAt: string | null | undefined
  if (hasExpiresIn) {
    let preset: string | null = null
    if (typeof body.expiresIn === "string") {
      const trimmed = body.expiresIn.trim()
      if (
        trimmed !== "" &&
        trimmed !== "never" &&
        !isValidExpiresInPreset(trimmed)
      ) {
        return apiError(
          c,
          400,
          "INVALID_EXPIRES_IN",
          "Invalid expiration preset (allowed: never, 1h, 24h, 7d, 30d)"
        )
      }
      preset = trimmed === "" ? null : trimmed
    } else if (body.expiresIn === null) {
      preset = null
    } else {
      return apiError(
        c,
        400,
        "INVALID_EXPIRES_IN",
        "Invalid expiration preset (allowed: never, 1h, 24h, 7d, 30d)"
      )
    }
    newExpiresAt = calculateExpiresAt(preset)
  }

  const updated = await updateFileRecord(c.env.DB, prefix, userId, fileId, {
    ...(hasName ? { name: targetName } : {}),
    ...(hasFolderId ? { folderId: targetFolderId } : {}),
    ...(hasExpiresIn ? { expiresAt: newExpiresAt } : {})
  })

  if (!updated) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  return c.json(toFileView(updated))
})

fileRoutes.post("/:id/shares", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const body = (await readJsonBody<{ expiresIn?: unknown }>(c)) ?? {}
  let preset = "file"
  if (typeof body.expiresIn === "string" && body.expiresIn.trim() !== "") {
    const trimmed = body.expiresIn.trim()
    if (
      trimmed !== "file" &&
      trimmed !== "never" &&
      !isValidExpiresInPreset(trimmed)
    ) {
      return apiError(c, 400, "INVALID_EXPIRES_IN", "Invalid expiration preset")
    }
    preset = trimmed
  }

  const share = await createShareRecord(
    c.env.DB,
    prefix,
    userId,
    fileId,
    preset
  )

  if (!share) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found or expired")
  }

  const origin = new URL(c.req.url).origin
  const url = `${origin}/s/${share.token}`

  return c.json(
    {
      id: share.id,
      url,
      expires_at: share.expiresAt,
      tokenSuffix: share.tokenSuffix
    },
    201
  )
})

fileRoutes.get("/:id/shares", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const file = await findFileById(c.env.DB, prefix, userId, fileId)
  if (!file) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  const shares = await listSharesByFile(c.env.DB, prefix, userId, fileId)
  return c.json({ items: shares })
})
