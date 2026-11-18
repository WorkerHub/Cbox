import { describe, expect, it } from "vitest"
import { filesTable, userLimitsTable } from "../src/lib/tables"
import {
  activePrefix,
  directUpload,
  initializedContext,
  postJson,
  request,
  seedSession
} from "./support/app"

describe("Direct Uploads 直传架构全流程测试 (Todo #14)", () => {
  it("Single 模式直传：init 签发带 Content-Length 与 Content-Type 约束的预签名 URL，完成后转为 active", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "Hello Direct Single Upload"
    const contentBytes = new TextEncoder().encode(content)

    // 1. Init
    const initRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "test-single.txt",
        declaredSizeBytes: contentBytes.byteLength,
        contentType: "text/plain",
        expiresIn: "24h"
      },
      { cookie: user.cookie }
    )

    expect(initRes.status).toBe(201)
    const initData = (await initRes.json()) as {
      uploadId: string
      mode: string
      partSize: number
      url: string
    }

    expect(initData.mode).toBe("single")
    expect(initData.uploadId).toBeDefined()
    expect(initData.partSize).toBe(10 * 1024 * 1024)
    expect(initData.url).toContain("X-Amz-SignedHeaders=")
    expect(initData.url).toContain("content-length")
    expect(initData.url).toContain("content-type")

    // 验证 pending 状态已落库，但不在文件列表中出现
    const pendingRow = await env.DB.prepare(
      `SELECT status, size_bytes FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(initData.uploadId)
      .first<{ status: string; size_bytes: number }>()

    expect(pendingRow?.status).toBe("pending")
    expect(pendingRow?.size_bytes).toBe(contentBytes.byteLength)

    const listRes = await request(env, "/api/folders", {
      headers: { cookie: user.cookie }
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { files: Array<{ id: string }> }
    expect(listBody.files.some((f) => f.id === initData.uploadId)).toBe(false)

    // 2. 模拟客户端直传到 R2 (S3)
    await env.S3_FETCH!(initData.url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: contentBytes
    })

    // 3. Complete
    const completeRes = await postJson(
      env,
      `/api/files/uploads/${initData.uploadId}/complete`,
      { sha256: "dummy-sha256" },
      { cookie: user.cookie }
    )
    expect(completeRes.status).toBe(200)
    const file = (await completeRes.json()) as {
      id: string
      name: string
      sizeBytes: number
      sha256: string
    }
    expect(file.id).toBe(initData.uploadId)
    expect(file.name).toBe("test-single.txt")
    expect(file.sizeBytes).toBe(contentBytes.byteLength)
    expect(file.sha256).toBe("dummy-sha256")

    // 验证完成后的状态变为 active
    const activeRow = await env.DB.prepare(
      `SELECT status FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(initData.uploadId)
      .first<{ status: string }>()
    expect(activeRow?.status).toBe("active")

    // 验证在文件列表中可列出
    const listAfter = await request(env, "/api/folders", {
      headers: { cookie: user.cookie }
    })
    const listAfterBody = (await listAfter.json()) as {
      files: Array<{ id: string }>
    }
    expect(listAfterBody.files.some((f) => f.id === initData.uploadId)).toBe(
      true
    )

    // 验证可正常下载
    const downRes = await request(env, `/api/files/${file.id}/download`, {
      headers: { cookie: user.cookie }
    })
    expect(downRes.status).toBe(200)
    expect(await downRes.text()).toBe(content)
  })

  it("Multipart 模式直传：>100 MiB 自动走 multipart，支持分片并发签发与合并", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const bigSize = 120 * 1024 * 1024 // 120 MiB > 100 MiB

    // 1. Init
    const initRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "large-video.mp4",
        declaredSizeBytes: bigSize,
        contentType: "video/mp4"
      },
      { cookie: user.cookie }
    )
    expect(initRes.status).toBe(201)
    const initData = (await initRes.json()) as {
      uploadId: string
      mode: string
      partSize: number
    }
    expect(initData.mode).toBe("multipart")
    expect(initData.partSize).toBe(10 * 1024 * 1024)

    // 2. Part URLs: 请求 2 个分片的预签名 URL
    const partRes = await postJson(
      env,
      `/api/files/uploads/${initData.uploadId}/part-urls`,
      { partNumbers: [1, 2] },
      { cookie: user.cookie }
    )
    expect(partRes.status).toBe(200)
    const { parts } = (await partRes.json()) as {
      parts: Array<{ partNumber: number; url: string }>
    }
    expect(parts.length).toBe(2)
    expect(parts[0].partNumber).toBe(1)
    expect(parts[0].url).toContain("partNumber=1")
    expect(parts[1].partNumber).toBe(2)
    expect(parts[1].url).toContain("partNumber=2")

    // 上传两个分片
    const chunk1 = new Uint8Array(10 * 1024 * 1024).fill(1)
    const chunk2 = new Uint8Array(10 * 1024 * 1024).fill(2)
    const putRes1 = await env.S3_FETCH!(parts[0].url, {
      method: "PUT",
      body: chunk1
    })
    const etag1 = putRes1.headers.get("ETag") || `"etag-1"`
    const putRes2 = await env.S3_FETCH!(parts[1].url, {
      method: "PUT",
      body: chunk2
    })
    const etag2 = putRes2.headers.get("ETag") || `"etag-2"`

    // 3. Complete
    const completeRes = await postJson(
      env,
      `/api/files/uploads/${initData.uploadId}/complete`,
      {
        parts: [
          { partNumber: 1, etag: etag1 },
          { partNumber: 2, etag: etag2 }
        ]
      },
      { cookie: user.cookie }
    )
    expect(completeRes.status).toBe(200)
    const completeData = (await completeRes.json()) as {
      id: string
      sizeBytes: number
    }
    expect(completeData.sizeBytes).toBe(20 * 1024 * 1024)
  })

  it("DELETE /api/files/uploads/:id：中止未完成任务，删除 S3/R2 并即时释放预占配额", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 设置限额 5000 字节
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(user.userId, 5000, 5000, new Date().toISOString())
      .run()

    // 1. 发起一个占用 4000 字节的直传
    const initRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "aborted.bin",
        declaredSizeBytes: 4000
      },
      { cookie: user.cookie }
    )
    expect(initRes.status).toBe(201)
    const { uploadId } = (await initRes.json()) as { uploadId: string }

    // 此时再发起 2000 字节直传应被拒绝 (4000 + 2000 > 5000)
    const secondInit = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "second.bin",
        declaredSizeBytes: 2000
      },
      { cookie: user.cookie }
    )
    expect(secondInit.status).toBe(413)

    // 2. DELETE 中止任务
    const abortRes = await request(env, `/api/files/uploads/${uploadId}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(abortRes.status).toBe(200)

    // pending 记录已删除
    const row = await env.DB.prepare(
      `SELECT 1 FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(uploadId)
      .first()
    expect(row).toBeNull()

    // 3. 配额已释放，现在可以成功发起 2000 字节的直传
    const thirdInit = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "second.bin",
        declaredSizeBytes: 2000
      },
      { cookie: user.cookie }
    )
    expect(thirdInit.status).toBe(201)
  })

  it("限额与安全：同夹重名拦截、超配额拦截、非法分片请求拦截", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 先成功直传一个文件
    const upRes = await directUpload(env, user.cookie, {
      filename: "existing.txt",
      content: "content"
    })
    expect(upRes.status).toBe(200)

    // 1. 同名文件 init 报 409
    const conflictRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "existing.txt",
        declaredSizeBytes: 10
      },
      { cookie: user.cookie }
    )
    expect(conflictRes.status).toBe(409)

    // 2. 单直传超过 single 上限 (例如设限 100 字节，传 200 字节)
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(user.userId, 10000, 100, new Date().toISOString())
      .run()

    const tooBigRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "too-big.txt",
        declaredSizeBytes: 200
      },
      { cookie: user.cookie }
    )
    expect(tooBigRes.status).toBe(413)

    // 3. 对 single 模式直传请求 part-urls 报 400
    const singleInit = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "small.txt",
        declaredSizeBytes: 50
      },
      { cookie: user.cookie }
    )
    const singleData = (await singleInit.json()) as { uploadId: string }
    const partErr = await postJson(
      env,
      `/api/files/uploads/${singleData.uploadId}/part-urls`,
      { partNumbers: [1] },
      { cookie: user.cookie }
    )
    expect(partErr.status).toBe(400)
    expect(((await partErr.json()) as any).code).toBe("INVALID_UPLOAD_MODE")

    // 4. partNumbers 超出限制 (例如超过 50 个分片或含有非法数字)
    // 恢复该用户的限额以允许发起 150 MiB multipart
    await env.DB.prepare(
      `DELETE FROM ${userLimitsTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .run()

    const mpInit = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "big.bin",
        declaredSizeBytes: 150 * 1024 * 1024
      },
      { cookie: user.cookie }
    )
    expect(mpInit.status).toBe(201)
    const mpData = (await mpInit.json()) as { uploadId: string }
    const invalidParts = await postJson(
      env,
      `/api/files/uploads/${mpData.uploadId}/part-urls`,
      { partNumbers: Array.from({ length: 51 }, (_, i) => i + 1) },
      { cookie: user.cookie }
    )
    expect(invalidParts.status).toBe(400)
    expect(((await invalidParts.json()) as any).code).toBe(
      "INVALID_PART_NUMBERS"
    )
  })
})
