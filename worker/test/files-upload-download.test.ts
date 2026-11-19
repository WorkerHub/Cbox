import { describe, expect, it } from "vitest"
import { createFolder } from "../src/db/queries/folders"
import { filesTable, sharesTable, userLimitsTable } from "../src/lib/tables"
import {
  activePrefix,
  directUpload,
  initializedContext,
  postJson,
  request,
  seedSession
} from "./support/app"

describe("文件上传、流式下载、改期与删除（规格 §5、§10）", () => {
  it("直传成功并落元数据与 R2 对象", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "hello direct upload"
    const res = await directUpload(env, user.cookie, {
      filename: "hello.txt",
      expiresIn: "24h",
      contentType: "text/plain",
      content
    })

    expect(res.status).toBe(200)
    const file = (await res.json()) as {
      id: string
      name: string
      sizeBytes: number
      contentType: string
      expiresAt: string | null
    }

    expect(file.name).toBe("hello.txt")
    expect(file.sizeBytes).toBe(content.length)
    expect(file.contentType).toBe("text/plain")
    expect(file.expiresAt).not.toBeNull()

    // 验证 R2 中对象确实写入且内容一致
    const r2Obj = await r2.get(`u${user.userId}/${file.id}`)
    expect(r2Obj).not.toBeNull()
    expect(await r2Obj?.text()).toBe(content)
  })

  it("直传支持自定义 Content-Type 与 SHA-256 校验和", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const fileContent = "binary-like-jar-content-for-zeta"
    const sha256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    const res = await directUpload(env, user.cookie, {
      filename: "spark-app.jar",
      contentType: "application/java-archive",
      expiresIn: "1h",
      sha256,
      content: fileContent
    })

    expect(res.status).toBe(200)
    const file = (await res.json()) as {
      id: string
      name: string
      sizeBytes: number
      contentType: string
      sha256: string | null
      expiresAt: string | null
    }

    expect(file.name).toBe("spark-app.jar")
    expect(file.sizeBytes).toBe(fileContent.length)
    expect(file.contentType).toBe("application/java-archive")
    expect(file.sha256).toBe(sha256)

    const r2Obj = await r2.get(`u${user.userId}/${file.id}`)
    expect(r2Obj).not.toBeNull()
    expect(await r2Obj?.text()).toBe(fileContent)
  })

  it("同一文件夹内文件名重名拒绝 (409 FILE_NAME_CONFLICT)", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 第一次上传
    const first = await directUpload(env, user.cookie, {
      filename: "data.csv",
      contentType: "text/csv",
      content: "col1,col2"
    })
    expect(first.status).toBe(200)

    // 第二次上传同名文件
    const second = await directUpload(env, user.cookie, {
      filename: "DATA.csv",
      contentType: "text/csv",
      content: "different,content"
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { code: string }).toMatchObject({
      code: "FILE_NAME_CONFLICT"
    })
  })

  it("超出生效单文件上限：服务端拒绝 (413 FILE_TOO_LARGE)、不落元数据、无 R2 孤儿", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 给该用户设单文件上限 10 字节
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(user.userId, 104857600, 10, new Date().toISOString())
      .run()

    // 尝试上传 20 字节的数据
    const payload = "12345678901234567890"
    const res = await directUpload(env, user.cookie, {
      filename: "toolarge.bin",
      content: payload
    })

    expect(res.status).toBe(413)
    const errBody = (await res.json()) as { code: string; limitBytes: number }
    expect(errBody.code).toBe("FILE_TOO_LARGE")
    expect(errBody.limitBytes).toBe(10)

    // 确认元数据未入库
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${filesTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .first<{ c: number }>()
    expect(rows?.c).toBe(0)

    // 确认 R2 中无遗留对象
    const list = await r2.list({ prefix: `u${user.userId}/` })
    expect(list.objects.length).toBe(0)
  })

  it("超出用户总容量上限：服务端拒绝 (413 QUOTA_EXCEEDED)", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 给该用户设总容量 15 字节，单文件上限 100 字节
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(user.userId, 15, 100, new Date().toISOString())
      .run()

    // 第一传 10 字节成功
    const f1 = await directUpload(env, user.cookie, {
      filename: "first.bin",
      content: "1234567890"
    })
    expect(f1.status).toBe(200)

    // 第二传 10 字节超总容量（已用 10 + 需 10 > 15）
    const f2 = await directUpload(env, user.cookie, {
      filename: "second.bin",
      content: "abcdefghij"
    })
    expect(f2.status).toBe(413)
    const errBody = (await f2.json()) as { code: string; limitBytes: number }
    expect(errBody.code).toBe("QUOTA_EXCEEDED")
    expect(errBody.limitBytes).toBe(15)

    // R2 中只有第一个文件
    const list = await r2.list({ prefix: `u${user.userId}/` })
    expect(list.objects.length).toBe(1)
  })

  it("直传完成时实际对象超出单文件上限：服务端拒绝 (413 FILE_TOO_LARGE)、删除已写对象、清理 pending 记录、无残留", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 设单文件上限 10 字节
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(user.userId, 104857600, 10, new Date().toISOString())
      .run()

    // 声明为 8 字节（通过 init 校验），但实际直传写了 16 字节
    const initRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "actual-toolarge.bin",
        declaredSizeBytes: 8
      },
      { cookie: user.cookie }
    )
    expect(initRes.status).toBe(201)
    const { uploadId, url } = (await initRes.json()) as {
      uploadId: string
      url: string
    }

    // 模拟写入 16 字节对象
    await env.S3_FETCH!(url, {
      method: "PUT",
      body: new TextEncoder().encode("1234567890123456")
    })

    // Complete 时复核限额拦截
    const completeRes = await postJson(
      env,
      `/api/files/uploads/${uploadId}/complete`,
      {},
      { cookie: user.cookie }
    )
    expect(completeRes.status).toBe(413)
    const errBody = (await completeRes.json()) as {
      code: string
      limitBytes: number
    }
    expect(errBody.code).toBe("FILE_TOO_LARGE")
    expect(errBody.limitBytes).toBe(10)

    // 确认元数据已清理
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${filesTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .first<{ c: number }>()
    expect(rows?.c).toBe(0)

    // 确认 R2 对象已被删除
    const list = await r2.list({ prefix: `u${user.userId}/` })
    expect(list.objects.length).toBe(0)
  })

  it("直传声明大小与实际上传一致且合规：正常上传成功 (200)、R2 与元数据完整", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const fullExpected = "chunk-data-1;chunk-data-2"
    const res = await directUpload(env, user.cookie, {
      filename: "direct-ok.txt",
      expiresIn: "1h",
      contentType: "text/plain",
      content: fullExpected
    })

    expect(res.status).toBe(200)
    const file = (await res.json()) as {
      id: string
      name: string
      sizeBytes: number
      contentType: string
    }
    expect(file.name).toBe("direct-ok.txt")
    expect(file.sizeBytes).toBe(fullExpected.length)

    // 确认元数据已正确入库
    const meta = await env.DB.prepare(
      `SELECT * FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(file.id)
      .first<{ size_bytes: number; name: string }>()
    expect(meta?.name).toBe("direct-ok.txt")
    expect(meta?.size_bytes).toBe(fullExpected.length)

    // 确认 R2 对象完整
    const r2Obj = await r2.get(`u${user.userId}/${file.id}`)
    expect(r2Obj).not.toBeNull()
    expect(await r2Obj?.text()).toBe(fullExpected)
  })

  it("GET /api/files/:id/download：登录态本人流式下载带完整标头", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "my-secret-content"
    const up = await directUpload(env, user.cookie, {
      filename: "doc 1.pdf",
      contentType: "application/pdf",
      content
    })
    const uploaded = (await up.json()) as { id: string }

    const down = await request(env, `/api/files/${uploaded.id}/download`, {
      headers: { cookie: user.cookie }
    })
    expect(down.status).toBe(200)
    expect(down.headers.get("content-type")).toBe("application/pdf")
    expect(down.headers.get("content-disposition")).toContain("attachment;")
    expect(down.headers.get("content-length")).toBe(String(content.length))
    expect(down.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await down.text()).toBe(content)
  })

  it("文件到期后本人下载即刻 404（失败关闭，不区分已过期与不存在）", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const up = await directUpload(env, user.cookie, {
      filename: "temp.txt",
      content: "temp"
    })
    const uploaded = (await up.json()) as { id: string }

    // 把该文件在数据库中的 expires_at 设为过去
    await env.DB.prepare(
      `UPDATE ${filesTable(prefix)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(uploaded.id)
      .run()

    const down = await request(env, `/api/files/${uploaded.id}/download`, {
      headers: { cookie: user.cookie }
    })
    expect(down.status).toBe(404)
  })

  it("PATCH /api/files/:id 改过期：设为永不过期后下载恢复正常", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const up = await directUpload(env, user.cookie, {
      filename: "temp2.txt",
      content: "temp2"
    })
    const uploaded = (await up.json()) as { id: string }

    // 先改成过去使其过期
    await env.DB.prepare(
      `UPDATE ${filesTable(prefix)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(uploaded.id)
      .run()

    expect(
      (
        await request(env, `/api/files/${uploaded.id}/download`, {
          headers: { cookie: user.cookie }
        })
      ).status
    ).toBe(404)

    // PATCH 改为永不过期 (never)
    const patchRes = await request(env, `/api/files/${uploaded.id}`, {
      method: "PATCH",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "never" })
    })
    expect(patchRes.status).toBe(200)
    expect((await patchRes.json()) as { expiresAt: null }).toMatchObject({
      expiresAt: null
    })

    // 下载恢复正常 200
    const down = await request(env, `/api/files/${uploaded.id}/download`, {
      headers: { cookie: user.cookie }
    })
    expect(down.status).toBe(200)
    expect(await down.text()).toBe("temp2")
  })

  it("DELETE /api/files/:id：删除 R2 对象、分享记录与文件元数据", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const up = await directUpload(env, user.cookie, {
      filename: "todelete.txt",
      content: "to-delete"
    })
    const uploaded = (await up.json()) as { id: string }

    // 为该文件创建一个分享
    const shareRes = await request(env, `/api/files/${uploaded.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "24h" })
    })
    expect(shareRes.status).toBe(201)

    // 删除文件
    const delRes = await request(env, `/api/files/${uploaded.id}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(delRes.status).toBe(200)

    // 验证 R2 对象已被清除
    expect(await r2.get(`u${user.userId}/${uploaded.id}`)).toBeNull()

    // 验证文件与分享行均已清除
    const fRow = await env.DB.prepare(
      `SELECT 1 FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(uploaded.id)
      .first()
    expect(fRow).toBeNull()

    const sRow = await env.DB.prepare(
      `SELECT 1 FROM ${sharesTable(prefix)} WHERE file_id = ?`
    )
      .bind(uploaded.id)
      .first()
    expect(sRow).toBeNull()
  })

  describe("PATCH /api/files/:id 改名与移动（扩展 name / folderId）", () => {
    it("改名成功：文件列表与下载文件名同步为新名、已有分享链接照常且下载为新名、R2 对象与文件内容不变", async () => {
      const { env, db, r2 } = await initializedContext()
      const prefix = activePrefix(env)
      const user = await seedSession(db, prefix, { role: "user" })

      const content = "content-for-rename-test"
      const up = await directUpload(env, user.cookie, {
        filename: "old-name.txt",
        content
      })
      expect(up.status).toBe(200)
      const file = (await up.json()) as { id: string; name: string }
      const expectedR2Key = `u${user.userId}/${file.id}`

      // 创建一个分享
      const shareRes = await request(env, `/api/files/${file.id}/shares`, {
        method: "POST",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "file" })
      })
      expect(shareRes.status).toBe(201)
      const share = (await shareRes.json()) as { url: string }
      const shareToken = share.url.split("/s/")[1]

      // 发起 PATCH 改名
      const patchRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "new-name.txt" })
      })
      expect(patchRes.status).toBe(200)
      const patched = (await patchRes.json()) as { id: string; name: string }
      expect(patched.id).toBe(file.id)
      expect(patched.name).toBe("new-name.txt")

      // 1. 文件列表同步为新名
      const folderRes = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      expect(folderRes.status).toBe(200)
      const folderData = (await folderRes.json()) as {
        files: Array<{ id: string; name: string }>
      }
      expect(folderData.files.find((f) => f.id === file.id)?.name).toBe(
        "new-name.txt"
      )

      // 2. 登录态下载 Content-Disposition 为新名
      const downRes = await request(env, `/api/files/${file.id}/download`, {
        headers: { cookie: user.cookie }
      })
      expect(downRes.status).toBe(200)
      expect(downRes.headers.get("content-disposition")).toContain(
        "new-name.txt"
      )
      expect(await downRes.text()).toBe(content)

      // 3. 已有分享链接照常可用且下载名为新名
      const shareDownRes = await request(env, `/s/${shareToken}`)
      expect(shareDownRes.status).toBe(200)
      expect(shareDownRes.headers.get("content-disposition")).toContain(
        "new-name.txt"
      )
      expect(await shareDownRes.text()).toBe(content)

      // 4. R2 对象与文件内容不变
      const r2Obj = await r2.get(expectedR2Key)
      expect(r2Obj).not.toBeNull()
      expect(await r2Obj?.text()).toBe(content)

      // 5. 改名为自身当前名：幂等成功，不报错 409
      const selfRenameRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "new-name.txt" })
      })
      expect(selfRenameRes.status).toBe(200)
    })

    it("移动成功：从原文件夹消失、出现在目标文件夹、移到根目录可用、空间用量不变", async () => {
      const { env, db } = await initializedContext()
      const prefix = activePrefix(env)
      const user = await seedSession(db, prefix, { role: "user" })

      // 创建文件夹 A 与文件夹 B
      const folderA = await createFolder(env.DB, prefix, user.userId, {
        parentId: null,
        name: "FolderA"
      })
      const folderB = await createFolder(env.DB, prefix, user.userId, {
        parentId: null,
        name: "FolderB"
      })

      // 上传文件到根目录
      const up = await directUpload(env, user.cookie, {
        filename: "doc.pdf",
        content: "pdf-document-content"
      })
      expect(up.status).toBe(200)
      const file = (await up.json()) as { id: string }

      // 记录初始用量
      const initFolderRes = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      const initUsage = (await initFolderRes.json()) as {
        usage: { usedBytes: number }
      }
      expect(initUsage.usage.usedBytes).toBe("pdf-document-content".length)

      // 移动到文件夹 A
      const moveARes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: folderA.id })
      })
      expect(moveARes.status).toBe(200)
      const movedA = (await moveARes.json()) as {
        id: string
        folderId: string | null
      }
      expect(movedA.folderId).toBe(folderA.id)

      // 验证：根目录没有该文件
      const rootCheck = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      const rootData = (await rootCheck.json()) as {
        files: Array<{ id: string }>
        usage: { usedBytes: number }
      }
      expect(rootData.files.find((f) => f.id === file.id)).toBeUndefined()
      // 空间用量保持不变
      expect(rootData.usage.usedBytes).toBe(initUsage.usage.usedBytes)

      // 验证：文件夹 A 中出现该文件
      const folderACheck = await request(
        env,
        `/api/folders?parentId=${folderA.id}`,
        {
          headers: { cookie: user.cookie }
        }
      )
      const folderAData = (await folderACheck.json()) as {
        files: Array<{ id: string }>
      }
      expect(folderAData.files.find((f) => f.id === file.id)).toBeDefined()

      // 从文件夹 A 移动到文件夹 B
      const moveBRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: folderB.id })
      })
      expect(moveBRes.status).toBe(200)

      // 验证：文件夹 A 中消失，文件夹 B 中出现
      const folderACheck2 = await request(
        env,
        `/api/folders?parentId=${folderA.id}`,
        {
          headers: { cookie: user.cookie }
        }
      )
      expect(
        ((await folderACheck2.json()) as any).files.find(
          (f: any) => f.id === file.id
        )
      ).toBeUndefined()

      const folderBCheck = await request(
        env,
        `/api/folders?parentId=${folderB.id}`,
        {
          headers: { cookie: user.cookie }
        }
      )
      expect(
        ((await folderBCheck.json()) as any).files.find(
          (f: any) => f.id === file.id
        )
      ).toBeDefined()

      // 移回根目录 (folderId: null)
      const moveRootRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: null })
      })
      expect(moveRootRes.status).toBe(200)
      expect(((await moveRootRes.json()) as any).folderId).toBeNull()

      const rootFinalCheck = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      const rootFinalData = (await rootFinalCheck.json()) as {
        files: Array<{ id: string }>
        usage: { usedBytes: number }
      }
      expect(rootFinalData.files.find((f) => f.id === file.id)).toBeDefined()
      expect(rootFinalData.usage.usedBytes).toBe(initUsage.usage.usedBytes)
    })

    it("同名冲突（409 FILE_NAME_CONFLICT）且原文件不变", async () => {
      const { env, db } = await initializedContext()
      const prefix = activePrefix(env)
      const user = await seedSession(db, prefix, { role: "user" })

      const folder = await createFolder(env.DB, prefix, user.userId, {
        parentId: null,
        name: "TargetDir"
      })

      // 在根目录下上传 file1.txt 和 file2.txt
      const up1 = await directUpload(env, user.cookie, {
        filename: "file1.txt",
        content: "1"
      })
      const f1 = (await up1.json()) as { id: string }

      await directUpload(env, user.cookie, {
        filename: "file2.txt",
        content: "2"
      })

      // 1. 同目录改名重名（不区分大小写 FILE2.TXT）
      const conflictRename = await request(env, `/api/files/${f1.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "FILE2.TXT" })
      })
      expect(conflictRename.status).toBe(409)
      expect((await conflictRename.json()) as any).toMatchObject({
        code: "FILE_NAME_CONFLICT"
      })

      // 验证 f1 名字未改变
      const checkF1 = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      expect(
        ((await checkF1.json()) as any).files.find((f: any) => f.id === f1.id)
          ?.name
      ).toBe("file1.txt")

      // 在 TargetDir 下也上传一个 file1.txt
      await directUpload(env, user.cookie, {
        filename: "file1.txt",
        folderId: folder.id,
        content: "target-1"
      })

      // 2. 移动到 TargetDir，同名冲突
      const conflictMove = await request(env, `/api/files/${f1.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: folder.id })
      })
      expect(conflictMove.status).toBe(409)
      expect((await conflictMove.json()) as any).toMatchObject({
        code: "FILE_NAME_CONFLICT"
      })

      // 验证 f1 仍在根目录
      const checkF1AfterMove = await request(env, "/api/folders", {
        headers: { cookie: user.cookie }
      })
      expect(
        ((await checkF1AfterMove.json()) as any).files.find(
          (f: any) => f.id === f1.id
        )
      ).toBeDefined()

      // 3. 同时改名 + 移动：只校验最终落点
      // TargetDir 下已有 file1.txt，但没有 file-renamed.txt
      const moveAndRenameOk = await request(env, `/api/files/${f1.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "file-renamed.txt",
          folderId: folder.id
        })
      })
      expect(moveAndRenameOk.status).toBe(200)
      const movedResult = (await moveAndRenameOk.json()) as any
      expect(movedResult.name).toBe("file-renamed.txt")
      expect(movedResult.folderId).toBe(folder.id)

      // 若同时改名 + 移动到 TargetDir，但新名在 TargetDir 已存在（如 file1.txt）
      // 此时 f1 在 TargetDir 下名为 file-renamed.txt，尝试改名为 file1.txt
      const moveAndRenameConflict = await request(env, `/api/files/${f1.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "file1.txt",
          folderId: folder.id
        })
      })
      expect(moveAndRenameConflict.status).toBe(409)
      expect((await moveAndRenameConflict.json()) as any).toMatchObject({
        code: "FILE_NAME_CONFLICT"
      })
    })

    it("参数校验与归属隔离：空请求体/空名/超长/含斜杠/他人文件夹/他人文件被拒", async () => {
      const { env, db } = await initializedContext()
      const prefix = activePrefix(env)
      const user1 = await seedSession(db, prefix, {
        role: "user",
        email: "u1-check@example.test"
      })
      const user2 = await seedSession(db, prefix, {
        role: "user",
        email: "u2-check@example.test"
      })

      const up = await directUpload(env, user1.cookie, {
        filename: "valid.txt",
        content: "hello"
      })
      const file = (await up.json()) as { id: string }

      // 1. 无任何字段或空请求体 -> 400
      const emptyRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({})
      })
      expect(emptyRes.status).toBe(400)
      expect((await emptyRes.json()) as any).toMatchObject({
        code: "INVALID_REQUEST"
      })

      // 2. 空文件名 -> 400
      const emptyNameRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "" })
      })
      expect(emptyNameRes.status).toBe(400)
      expect((await emptyNameRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      // 3. 纯空格文件名 -> 400
      const spaceNameRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "   " })
      })
      expect(spaceNameRes.status).toBe(400)
      expect((await spaceNameRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      // 4. 超长文件名 (>255 字符) -> 400
      const longName = "a".repeat(256)
      const longNameRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: longName })
      })
      expect(longNameRes.status).toBe(400)
      expect((await longNameRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      // 5. 含正斜杠或反斜杠 -> 400
      const slashRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "sub/test.txt" })
      })
      expect(slashRes.status).toBe(400)
      expect((await slashRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      const backslashRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "sub\\test.txt" })
      })
      expect(backslashRes.status).toBe(400)
      expect((await backslashRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      // 6. . 与 .. -> 400
      const dotRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "." })
      })
      expect(dotRes.status).toBe(400)
      expect((await dotRes.json()) as any).toMatchObject({
        code: "INVALID_FILENAME"
      })

      // 7. 移动到不存在的文件夹 -> 404 FOLDER_NOT_FOUND
      const nonExistFolderRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: "non-existent-uuid" })
      })
      expect(nonExistFolderRes.status).toBe(404)
      expect((await nonExistFolderRes.json()) as any).toMatchObject({
        code: "FOLDER_NOT_FOUND"
      })

      // 8. 移动到其他用户的文件夹 -> 404 FOLDER_NOT_FOUND
      const user2Folder = await createFolder(env.DB, prefix, user2.userId, {
        parentId: null,
        name: "User2Dir"
      })
      const otherFolderRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user1.cookie, "content-type": "application/json" },
        body: JSON.stringify({ folderId: user2Folder.id })
      })
      expect(otherFolderRes.status).toBe(404)
      expect((await otherFolderRes.json()) as any).toMatchObject({
        code: "FOLDER_NOT_FOUND"
      })

      // 9. 操作其他用户的文件 -> 404 FILE_NOT_FOUND
      const otherFileRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user2.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "hacked.txt" })
      })
      expect(otherFileRes.status).toBe(404)
      expect((await otherFileRes.json()) as any).toMatchObject({
        code: "FILE_NOT_FOUND"
      })
    })

    it("组合修改：一次请求同时改名 + 移动 + 改有效期，且超出新有效期的分享被同步截断", async () => {
      const { env, db } = await initializedContext()
      const prefix = activePrefix(env)
      const user = await seedSession(db, prefix, { role: "user" })

      const targetFolder = await createFolder(env.DB, prefix, user.userId, {
        parentId: null,
        name: "ComboTarget"
      })

      const up = await directUpload(env, user.cookie, {
        filename: "initial.txt",
        expiresIn: "30d",
        content: "combo-test"
      })
      const file = (await up.json()) as { id: string }

      // 建立一个 30d 有效期的分享
      const shareRes = await request(env, `/api/files/${file.id}/shares`, {
        method: "POST",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "file" })
      })
      expect(shareRes.status).toBe(201)
      const share = (await shareRes.json()) as {
        id: string
        expires_at: string
      }
      expect(share.expires_at).not.toBeNull()

      // 一次性提交：改名为 combo-done.txt、移动到 ComboTarget、有效期缩短到 1h
      const comboRes = await request(env, `/api/files/${file.id}`, {
        method: "PATCH",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "combo-done.txt",
          folderId: targetFolder.id,
          expiresIn: "1h"
        })
      })
      expect(comboRes.status).toBe(200)
      const comboData = (await comboRes.json()) as any
      expect(comboData.name).toBe("combo-done.txt")
      expect(comboData.folderId).toBe(targetFolder.id)
      expect(comboData.expiresAt).not.toBeNull()

      // 验证分享记录的到期时间被同步截断至新到期时间
      const updatedShareRow = await env.DB.prepare(
        `SELECT expires_at FROM ${sharesTable(prefix)} WHERE id = ?`
      )
        .bind(share.id)
        .first<{ expires_at: string }>()
      expect(updatedShareRow?.expires_at).toBe(comboData.expiresAt)
    })
  })
})
