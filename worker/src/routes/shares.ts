import { Hono } from "hono"
import {
  deleteShareRecord,
  findActiveShareByToken,
  incrementShareDownload
} from "../db/queries/shares"
import { currentUserId } from "../lib/account"
import { apiError } from "../lib/http"
import { getTablePrefix } from "../lib/table-prefix"
import type { HonoEnv } from "../types"

export const shareRoutes = new Hono<HonoEnv>()

shareRoutes.delete("/:id", async (c) => {
  const userId = currentUserId(c)
  const prefix = getTablePrefix(c.env)
  const shareId = c.req.param("id")?.trim()

  const deleted = await deleteShareRecord(c.env.DB, prefix, userId, shareId)
  if (!deleted) {
    return apiError(c, 404, "SHARE_NOT_FOUND", "Share not found")
  }

  return c.json({ success: true })
})

/**
 * 公开直链下载路由（挂在根级 /s/:token，规格 §6、§10）：
 * - 免登录、免 Cookie，直出 200 + Content-Disposition: attachment
 * - Content-Length + X-Content-Type-Options: nosniff
 * - 绝不跳转登录页或中间页
 * - 过期、撤销、文件删除或过期一律 404
 * - 成功下载异步递增计数与更新最后下载时间
 */
export async function handlePublicShareDownload(
  c: Parameters<typeof shareRoutes.fetch>[0] extends never ? any : any
): Promise<Response> {
  const token = c.req.param("token")?.trim()
  if (!token) {
    return c.text("Not found", 404)
  }

  const prefix = getTablePrefix(c.env)
  const share = await findActiveShareByToken(c.env.DB, prefix, token)
  if (!share) {
    return c.text("Not found", 404)
  }

  const r2Object = await c.env.FILES.get(share.r2Key)
  if (!r2Object?.body) {
    return c.text("Not found", 404)
  }

  // 递增下载计数（在 Worker 运行期不阻塞响应直出；测试中回落等待）
  try {
    c.executionCtx.waitUntil(
      incrementShareDownload(c.env.DB, prefix, share.shareId).catch((err) =>
        console.error("Failed to increment share download count:", err)
      )
    )
  } catch {
    await incrementShareDownload(c.env.DB, prefix, share.shareId).catch((err) =>
      console.error("Failed to increment share download count:", err)
    )
  }

  const encodedFilename = encodeURIComponent(share.fileName)
  const headers = new Headers({
    "Content-Type": share.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    "Content-Length": share.fileSizeBytes.toString(),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=0, must-revalidate"
  })

  return new Response(r2Object.body, {
    status: 200,
    headers
  })
}
