import { describe, expect, it } from "vitest"
import { filesTable, sharesTable, userLimitsTable } from "../src/lib/tables"
import {
  activePrefix,
  initializedContext,
  request,
  seedSession
} from "./support/app"

describe("文件上传、流式下载、改期与删除（规格 §5、§10）", () => {
  it("流式 raw body 上传成功并落元数据与 R2 对象", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "hello streaming raw"
    const res = await request(
      env,
      "/api/files?filename=hello.txt&expiresIn=24h",
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          "content-type": "text/plain"
        },
        body: content
      }
    )

    expect(res.status).toBe(201)
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

  it("multipart/form-data 表单上传成功（支持双格式通道）", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const fileContent = "binary-like-jar-content-for-zeta"
    const form = new FormData()
    form.append(
      "file",
      new Blob([fileContent], { type: "application/java-archive" }),
      "spark-app.jar"
    )
    form.append("expiresIn", "1h")
    form.append(
      "sha256",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )

    const res = await request(env, "/api/files", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: form
    })

    expect(res.status).toBe(201)
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
    expect(file.sha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )

    const r2Obj = await r2.get(`u${user.userId}/${file.id}`)
    expect(r2Obj).not.toBeNull()
    expect(await r2Obj?.text()).toBe(fileContent)
  })

  it("同一文件夹内文件名重名拒绝 (409 FILE_NAME_CONFLICT)", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 第一次上传
    const first = await request(env, "/api/files?filename=data.csv", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "text/csv" },
      body: "col1,col2"
    })
    expect(first.status).toBe(201)

    // 第二次上传同名文件
    const second = await request(env, "/api/files?filename=DATA.csv", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "text/csv" },
      body: "different,content"
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { code: string }).toMatchObject({
      code: "FILE_NAME_CONFLICT"
    })
  })

  it("超出生效单文件上限：服务端中止流、删除 R2 已写部分、不落元数据", async () => {
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
    const res = await request(env, "/api/files?filename=toolarge.bin", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        "content-type": "application/octet-stream"
      },
      body: payload
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

  it("超出用户总容量上限：服务端中止并拒绝 (413 QUOTA_EXCEEDED)", async () => {
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
    const f1 = await request(env, "/api/files?filename=first.bin", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "1234567890"
    })
    expect(f1.status).toBe(201)

    // 第二传 10 字节超总容量（已用 10 + 需 10 > 15）
    const f2 = await request(env, "/api/files?filename=second.bin", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "abcdefghij"
    })
    expect(f2.status).toBe(413)
    const errBody = (await f2.json()) as { code: string; limitBytes: number }
    expect(errBody.code).toBe("QUOTA_EXCEEDED")
    expect(errBody.limitBytes).toBe(15)

    // R2 中只有第一个文件
    const list = await r2.list({ prefix: `u${user.userId}/` })
    expect(list.objects.length).toBe(1)
  })

  it("GET /api/files/:id/download：登录态本人流式下载带完整标头", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "my-secret-content"
    const up = await request(env, "/api/files?filename=doc%201.pdf", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/pdf" },
      body: content
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

    const up = await request(env, "/api/files?filename=temp.txt", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "temp"
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

    const up = await request(env, "/api/files?filename=temp2.txt", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "temp2"
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

    const up = await request(env, "/api/files?filename=todelete.txt", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "to-delete"
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
})
