import { Hono } from "hono"
import {
  type LimitValidationResult,
  getUserUsageBytes,
  resolveUserLimits,
  validateUploadLimits
} from "../core/limits"
import {
  calculateExpiresAt,
  checkFileNameConflict,
  deleteFileRecord,
  findFileById,
  insertFileRecord,
  isFileExpired,
  isValidExpiresInPreset,
  updateFileExpiration
} from "../db/queries/files"
import { findFolderById } from "../db/queries/folders"
import { createShareRecord, listSharesByFile } from "../db/queries/shares"
import { currentUserId } from "../lib/account"
import { apiError, readJsonBody } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const fileRoutes = new Hono<HonoEnv>()

/**
 * 文件上传（规格 §5.2、§10）：
 * - 支持流式 body（raw stream）或 multipart/form-data（双支持）；
 * - 服务端边读边计数，超任一限额即中止并删除已写对象、不落元数据；
 * - 校验顺序：①单文件上限 ②用户总容量；
 * - 成功才落元数据。
 */
fileRoutes.post("/", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const contentTypeHeader = c.req.header("content-type") || ""

  let folderId: string | null = null
  let expiresIn: string | null = null
  let clientSha256: string | null = null
  let fileName = "unnamed"
  let fileContentType = "application/octet-stream"
  let inputStream: ReadableStream<Uint8Array> | null = null
  let announcedSize: number | null = null

  if (contentTypeHeader.includes("multipart/form-data")) {
    const formData = await c.req.formData().catch(() => null)
    if (!formData) {
      return apiError(c, 400, "INVALID_FORM_DATA", "Invalid form data")
    }

    const fileField = formData.get("file")
    if (!fileField || !(fileField instanceof File)) {
      return apiError(c, 400, "MISSING_FILE", "File is required")
    }

    fileName = fileField.name || "unnamed"
    fileContentType = fileField.type || "application/octet-stream"
    announcedSize = fileField.size
    inputStream = fileField.stream() as unknown as ReadableStream<Uint8Array>

    const rawFolderId = formData.get("folderId")
    if (typeof rawFolderId === "string" && rawFolderId.trim() !== "") {
      folderId = rawFolderId.trim()
    }

    const rawExpiresIn = formData.get("expiresIn")
    if (typeof rawExpiresIn === "string" && rawExpiresIn.trim() !== "") {
      expiresIn = rawExpiresIn.trim()
    }

    const rawSha256 = formData.get("sha256")
    if (typeof rawSha256 === "string" && rawSha256.trim() !== "") {
      clientSha256 = rawSha256.trim()
    }
  } else {
    // 流式 raw body
    inputStream = c.req.raw.body
    if (!inputStream) {
      return apiError(c, 400, "EMPTY_BODY", "Request body is empty")
    }

    const rawFolderId =
      c.req.query("folderId") || c.req.header("x-folder-id") || null
    if (rawFolderId && rawFolderId.trim() !== "") {
      folderId = rawFolderId.trim()
    }

    const rawExpiresIn =
      c.req.query("expiresIn") || c.req.header("x-expires-in") || null
    if (rawExpiresIn && rawExpiresIn.trim() !== "") {
      expiresIn = rawExpiresIn.trim()
    }

    const rawSha256 = c.req.query("sha256") || c.req.header("x-sha256") || null
    if (rawSha256 && rawSha256.trim() !== "") {
      clientSha256 = rawSha256.trim()
    }

    const rawFilename =
      c.req.query("filename") || c.req.header("x-filename") || null
    if (rawFilename && rawFilename.trim() !== "") {
      try {
        fileName = decodeURIComponent(rawFilename.trim())
      } catch {
        fileName = rawFilename.trim()
      }
    }

    fileContentType = contentTypeHeader || "application/octet-stream"

    const clHeader = c.req.header("content-length")
    if (clHeader) {
      const parsedCl = Number(clHeader)
      if (Number.isInteger(parsedCl) && parsedCl >= 0) {
        announcedSize = parsedCl
      }
    }
  }

  // 1. 文件夹有效性检查
  if (folderId !== null) {
    const folder = await findFolderById(c.env.DB, prefix, userId, folderId)
    if (!folder) {
      return apiError(c, 404, "FOLDER_NOT_FOUND", "Folder not found")
    }
  }

  // 2. 文件重名冲突检查
  if (
    await checkFileNameConflict(c.env.DB, prefix, userId, folderId, fileName)
  ) {
    return apiError(
      c,
      409,
      "FILE_NAME_CONFLICT",
      "A file with the same name already exists in this folder"
    )
  }

  // 3. 限额预检
  const limits = await resolveUserLimits(c.env.DB, prefix, userId)
  const currentUsage = await getUserUsageBytes(c.env.DB, prefix, userId)

  if (announcedSize !== null && announcedSize > 0) {
    const earlyCheck = validateUploadLimits(limits, currentUsage, announcedSize)
    if (!earlyCheck.ok) {
      return apiError(c, 413, earlyCheck.code, earlyCheck.error, {
        limitBytes: earlyCheck.limitBytes
      })
    }
  }

  // 4. 流式传输至 R2，边读边计数超限中止
  const fileId = crypto.randomUUID()
  const r2Key = `u${userId}/${fileId}`

  let bytesWritten = 0
  const limitFailureRef: { current: LimitValidationResult | null } = {
    current: null
  }

  const countingStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesWritten += chunk.byteLength
      const check = validateUploadLimits(limits, currentUsage, bytesWritten)
      if (!check.ok) {
        limitFailureRef.current = check
        controller.error(new Error(check.code))
        return
      }
      controller.enqueue(chunk)
    }
  })

  try {
    let uploadStream: ReadableStream<Uint8Array> =
      inputStream.pipeThrough(countingStream)
    const FLS = (
      globalThis as unknown as {
        FixedLengthStream?: new (len: number) => TransformStream
      }
    ).FixedLengthStream
    if (announcedSize !== null && typeof FLS === "function") {
      const fls = new FLS(announcedSize)
      uploadStream.pipeTo(fls.writable).catch(() => {})
      uploadStream = fls.readable
    }

    await c.env.FILES.put(r2Key, uploadStream, {
      httpMetadata: {
        contentType: fileContentType
      }
    })
  } catch (err) {
    // 写入失败或超限中止：立即删除 R2 对象，绝不落元数据（规格 §5.2）
    await c.env.FILES.delete(r2Key)
    const failure = limitFailureRef.current
    if (failure && !failure.ok) {
      return apiError(c, 413, failure.code, failure.error, {
        limitBytes: failure.limitBytes
      })
    }
    console.error("R2 stream write error:", err)
    return apiError(c, 500, "UPLOAD_FAILED", "Failed to upload file")
  }

  // 5. 写入成功后的并发竞态复查
  const recheckedUsage = await getUserUsageBytes(c.env.DB, prefix, userId)
  const finalCheck = validateUploadLimits(limits, recheckedUsage, bytesWritten)
  if (!finalCheck.ok) {
    await c.env.FILES.delete(r2Key)
    return apiError(c, 413, finalCheck.code, finalCheck.error, {
      limitBytes: finalCheck.limitBytes
    })
  }

  // 6. 落 D1 元数据
  const expiresAt = calculateExpiresAt(expiresIn)
  const fileRecord = await insertFileRecord(c.env.DB, prefix, {
    id: fileId,
    userId,
    folderId,
    name: fileName,
    sizeBytes: bytesWritten,
    contentType: fileContentType,
    sha256: clientSha256,
    r2Key,
    expiresAt
  })

  return c.json(fileRecord, 201)
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

  const body = await readJsonBody<{ expiresIn?: unknown }>(c)
  if (!body) {
    return apiError(c, 400, "INVALID_REQUEST", "Invalid request body")
  }

  let preset: string | null = null
  if (typeof body.expiresIn === "string") {
    if (
      body.expiresIn !== "" &&
      body.expiresIn !== "never" &&
      !isValidExpiresInPreset(body.expiresIn)
    ) {
      return apiError(
        c,
        400,
        "INVALID_EXPIRES_IN",
        "Invalid expiration preset (allowed: never, 1h, 24h, 7d, 30d)"
      )
    }
    preset = body.expiresIn
  }

  const newExpiresAt = calculateExpiresAt(preset)
  const updated = await updateFileExpiration(
    c.env.DB,
    prefix,
    userId,
    fileId,
    newExpiresAt
  )

  if (!updated) {
    return apiError(c, 404, "FILE_NOT_FOUND", "File not found")
  }

  return c.json({
    id: updated.id,
    expiresAt: updated.expires_at
  })
})

fileRoutes.post("/:id/shares", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const fileId = c.req.param("id")?.trim()

  const body = (await readJsonBody<{ expiresIn?: unknown }>(c)) ?? {}
  let preset = "24h"
  if (typeof body.expiresIn === "string" && body.expiresIn.trim() !== "") {
    const trimmed = body.expiresIn.trim()
    if (trimmed !== "never" && !isValidExpiresInPreset(trimmed)) {
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
