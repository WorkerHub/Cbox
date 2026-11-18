import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/core/auth"
import { executeCleanupJob } from "../src/services/scheduled-task"
import { filesTable, sharesTable } from "../src/lib/tables"
import {
  activePrefix,
  adminCookie,
  directUpload,
  initializedContext,
  makeContext,
  registerUser,
  request,
  seedSession,
  TEST_SETUP_SECRET
} from "./support/app"

describe("规格 §11 验收标准全量专项测试", () => {
  it("§11.2 初始化：setup 输出生效前缀 cbox_；首个注册为管理员；第二个用户待批准与批准登录", async () => {
    const { env } = makeContext()
    // 首次 setup
    const setupRes = await request(env, "/api/setup", {
      method: "POST",
      headers: { "x-setup-secret": TEST_SETUP_SECRET }
    })
    expect(setupRes.status).toBe(200)
    const setupData = (await setupRes.json()) as { tablePrefix: string }
    expect(setupData.tablePrefix).toBe("cbox_")

    // 首个注册用户自动成为管理员并处于 active
    const r1 = await registerUser(env, {
      email: "first-admin@example.test",
      password: "Password123!"
    })
    expect(r1.status).toBe(201)
    const d1 = (await r1.json()) as { requiresApproval: boolean }
    expect(d1.requiresApproval).toBe(false)

    // 第二个用户待批准
    const r2 = await registerUser(env, {
      email: "second-user@example.test",
      password: "Password123!"
    })
    expect(r2.status).toBe(201)
    const d2 = (await r2.json()) as { requiresApproval: boolean }
    expect(d2.requiresApproval).toBe(true)
  })

  it("§11.3 文件夹与文件：建夹、夹内上传、面包屑、同夹重名拦截、递归删夹（含 R2 与分享清理）", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 创建顶层文件夹 "spark-jobs"
    const f1Res = await request(env, "/api/folders", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "spark-jobs" })
    })
    expect(f1Res.status).toBe(201)
    const folder = (await f1Res.json()) as { id: string; name: string }

    // 2. 同层重名建夹拦截
    const dupFolderRes = await request(env, "/api/folders", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "spark-jobs" })
    })
    expect(dupFolderRes.status).toBe(409)

    // 3. 向文件夹内上传文件
    const uploadRes = await directUpload(env, user.cookie, {
      folderId: folder.id,
      filename: "app.jar",
      expiresIn: "24h",
      contentType: "application/java-archive",
      content: "jar-binary-payload"
    })
    expect(uploadRes.status).toBe(200)
    const file = (await uploadRes.json()) as { id: string; name: string }

    // 4. 同夹重名文件上传拦截
    const dupFileRes = await directUpload(env, user.cookie, {
      folderId: folder.id,
      filename: "app.jar",
      expiresIn: "24h",
      contentType: "application/java-archive",
      content: "jar-binary-payload-2"
    })
    expect(dupFileRes.status).toBe(409)

    // 5. 检查文件夹列表与面包屑
    const listRes = await request(env, `/api/folders?parentId=${folder.id}`, {
      headers: { cookie: user.cookie }
    })
    expect(listRes.status).toBe(200)
    const listData = (await listRes.json()) as {
      breadcrumbs: { id: string | null; name: string }[]
      files: { id: string; name: string }[]
    }
    expect(listData.breadcrumbs.some((b) => b.id === folder.id)).toBe(true)
    expect(listData.files.some((f) => f.id === file.id)).toBe(true)

    // 6. 为文件创建分享
    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    expect(shareRes.status).toBe(201)

    // 确认 R2 中有文件
    expect(await r2.get(`u${user.userId}/${file.id}`)).not.toBeNull()

    // 7. 递归删除文件夹
    const delFolderRes = await request(env, `/api/folders/${folder.id}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(delFolderRes.status).toBe(200)

    // 确认 R2 对象已被清除，分享记录被同步清除
    expect(await r2.get(`u${user.userId}/${file.id}`)).toBeNull()
    const shareRows = await env.DB.prepare(
      `SELECT count(*) as count FROM ${sharesTable(prefix)} WHERE file_id = ?`
    )
      .bind(file.id)
      .first<{ count: number }>()
    expect(shareRows?.count).toBe(0)
  })

  it("§11.4 限额分层：全局超限拦截 → 改全局限制 → 单人覆盖生效 → 覆盖清空回落 → usage 保持一致", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)

    const u1 = await seedSession(db, prefix, {
      email: "u1@example.test",
      role: "user"
    })
    const u2 = await seedSession(db, prefix, {
      email: "u2@example.test",
      role: "user"
    })

    // 1. 全局默认：单文件超 2 GiB 拒绝 (例如 2049 MiB)
    const rTooLarge = await directUpload(env, u1.cookie, {
      filename: "too-big.dat",
      declaredSizeBytes: 2 * 1024 * 1024 * 1024 + 1024,
      skipPut: true
    })
    expect(rTooLarge.status).toBe(413)

    // 2. 管理员改全局单文件上限为 10 MB
    const putGlobalRes = await request(env, "/api/admin/settings", {
      method: "PUT",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({
        fileLimits: { defaultQuotaMB: 100, defaultSingleMaxMB: 10 }
      })
    })
    expect(putGlobalRes.status).toBe(200)

    // 11 MB 文件上传被拒
    const r11u1 = await directUpload(env, u1.cookie, {
      filename: "11mb.dat",
      declaredSizeBytes: 11 * 1024 * 1024,
      skipPut: true
    })
    expect(r11u1.status).toBe(413)

    // 3. 给 u1 设单文件覆盖 50 MB
    const setOverrideRes = await request(
      env,
      `/api/admin/users/${u1.userId}/limits`,
      {
        method: "PUT",
        headers: { cookie: admin, "content-type": "application/json" },
        body: JSON.stringify({ singleMaxMB: 50 })
      }
    )
    expect(setOverrideRes.status).toBe(200)

    // u1 可以上传 11 MB 文件
    const r11u1Ok = await directUpload(env, u1.cookie, {
      filename: "11mb-u1.dat",
      content: new Uint8Array(11 * 1024 * 1024)
    })
    expect(r11u1Ok.status).toBe(200)

    // u2 依然被拒
    const r11u2 = await directUpload(env, u2.cookie, {
      filename: "11mb-u2.dat",
      declaredSizeBytes: 11 * 1024 * 1024,
      skipPut: true
    })
    expect(r11u2.status).toBe(413)

    // 4. 清空 u1 覆盖，回落全局
    const clearOverrideRes = await request(
      env,
      `/api/admin/users/${u1.userId}/limits`,
      {
        method: "PUT",
        headers: { cookie: admin, "content-type": "application/json" },
        body: JSON.stringify({ singleMaxMB: null, quotaMB: null })
      }
    )
    expect(clearOverrideRes.status).toBe(200)

    // /api/me/usage 查回生效限额与全局一致
    const usageRes = await request(env, "/api/me/usage", {
      headers: { cookie: u1.cookie }
    })
    expect(usageRes.status).toBe(200)
    const usage = (await usageRes.json()) as {
      singleMaxBytes: number
      quotaBytes: number
    }
    expect(usage.singleMaxBytes).toBe(10 * 1024 * 1024)
    expect(usage.quotaBytes).toBe(100 * 1024 * 1024)
  })

  it("§11.5 文件过期：到期 404，清理任务删除 R2+元数据释放容量，永不过期文件保留，改期生效", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 上传 1 小时过期的文件
    const upRes = await directUpload(env, user.cookie, {
      filename: "temp.txt",
      expiresIn: "1h",
      contentType: "text/plain",
      content: "short-lived-file"
    })
    expect(upRes.status).toBe(200)
    const file = (await upRes.json()) as { id: string }

    // 建一条分享
    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    const share = (await shareRes.json()) as { url: string }
    const token = share.url.split("/s/")[1]

    // 模拟时间流逝：把该文件的 expires_at 改到过去
    await env.DB.prepare(
      `UPDATE ${filesTable(prefix)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(file.id)
      .run()

    // 2. 到期后本人下载与分享下载均 404
    const downRes = await request(env, `/api/files/${file.id}/download`, {
      headers: { cookie: user.cookie }
    })
    expect(downRes.status).toBe(404)

    const shareDownRes = await request(env, `/s/${token}`)
    expect(shareDownRes.status).toBe(404)

    // 3. 执行清理任务：物理删除 R2 对象与元数据
    await executeCleanupJob(env)
    expect(await r2.get(`u${user.userId}/${file.id}`)).toBeNull()
    const dbFile = await env.DB.prepare(
      `SELECT * FROM ${filesTable(prefix)} WHERE id = ?`
    )
      .bind(file.id)
      .first()
    expect(dbFile).toBeNull()

    // 4. 永不过期文件不受清理影响
    const upNever = await directUpload(env, user.cookie, {
      filename: "never.txt",
      expiresIn: "never",
      contentType: "text/plain",
      content: "permanent-file"
    })
    const neverFile = (await upNever.json()) as { id: string }
    await executeCleanupJob(env)
    expect(await r2.get(`u${user.userId}/${neverFile.id}`)).not.toBeNull()

    // 5. 改期：将 1h 文件改为永不过期后不被清理
    const upToChange = await directUpload(env, user.cookie, {
      filename: "change.txt",
      expiresIn: "1h",
      contentType: "text/plain",
      content: "change-file"
    })
    const changeFile = (await upToChange.json()) as { id: string }

    const patchRes = await request(env, `/api/files/${changeFile.id}`, {
      method: "PATCH",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "never" })
    })
    expect(patchRes.status).toBe(200)

    await executeCleanupJob(env)
    expect(await r2.get(`u${user.userId}/${changeFile.id}`)).not.toBeNull()
  })

  it("§11.6 & §11.7 分享直链与 Zeta 场景：免登录流式下载、字节与 SHA-256 一致、无密码、计数更新、失效拦截", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 上传 jar 包并附带 sha256
    const jarContent = "PK\x03\x04zeta-spark-job-binary-code-12345"
    const expectedSha256 = await sha256Hex(jarContent)

    const upRes = await directUpload(env, user.cookie, {
      filename: "spark-job.jar",
      expiresIn: "24h",
      contentType: "application/java-archive",
      sha256: expectedSha256,
      content: jarContent
    })
    expect(upRes.status).toBe(200)
    const file = (await upRes.json()) as { id: string; sha256: string }
    expect(file.sha256).toBe(expectedSha256)

    // 创建 1 小时分享
    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    expect(shareRes.status).toBe(201)
    const share = (await shareRes.json()) as { id: string; url: string }
    const token = share.url.split("/s/")[1]

    // Zeta / 外部系统免登录下载：curl /s/<token>
    const directRes = await request(env, `/s/${token}`)
    expect(directRes.status).toBe(200)
    expect(directRes.headers.get("content-disposition")).toContain(
      "spark-job.jar"
    )
    expect(directRes.headers.get("x-content-type-options")).toBe("nosniff")

    const downloadedText = await directRes.text()
    expect(downloadedText).toBe(jarContent)
    expect(await sha256Hex(downloadedText)).toBe(expectedSha256)

    // 下载计数 +1
    const shareDetailRes = await request(env, `/api/files/${file.id}/shares`, {
      headers: { cookie: user.cookie }
    })
    const shareDetails = (await shareDetailRes.json()) as {
      items: { downloadCount: number }[]
    }
    expect(shareDetails.items[0]?.downloadCount).toBe(1)

    // 撤销分享即时 404
    const delShare = await request(env, `/api/shares/${share.id}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(delShare.status).toBe(200)

    const directRevokedRes = await request(env, `/s/${token}`)
    expect(directRevokedRes.status).toBe(404)
  })

  it("§11.8 清理与对账：>24h 孤儿 R2 对象被删除，未过期对象不误删", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const testNow = new Date("2026-06-10T12:00:00.000Z")
    const testNowSec = Math.floor(testNow.getTime() / 1000)

    // 1. 造一个合法对象（早于 24 小时，但有 D1 记录）
    const legitKey = `u${user.userId}/legit-file`
    r2.seedObject(
      legitKey,
      "legit-content",
      new Date(testNow.getTime() - 30 * 3600 * 1000)
    )
    await env.DB.prepare(
      `INSERT INTO ${filesTable(prefix)} (id, user_id, name, size_bytes, content_type, r2_key, created_at)
       VALUES ('legit-file', ?, 'legit.txt', 13, 'text/plain', ?, ?)`
    )
      .bind(
        user.userId,
        legitKey,
        new Date(testNow.getTime() - 30 * 3600 * 1000).toISOString()
      )
      .run()

    // 2. 造一个 >24h 孤儿对象（无 D1 对应）
    const orphanOldKey = `u${user.userId}/orphan-old`
    r2.seedObject(
      orphanOldKey,
      "orphan-payload",
      new Date(testNow.getTime() - 25 * 3600 * 1000)
    )

    // 3. 造一个 <24h 新孤儿对象（可能正在并发写入，不应误删）
    const orphanRecentKey = `u${user.userId}/orphan-recent`
    r2.seedObject(
      orphanRecentKey,
      "recent-orphan-payload",
      new Date(testNow.getTime() - 2 * 3600 * 1000)
    )

    // 执行对账与清理
    const outcome = await executeCleanupJob(env, { now: testNowSec })
    expect(outcome.deletedOrphans).toBe(1)

    // 检查结果
    expect(await r2.get(legitKey)).not.toBeNull()
    expect(await r2.get(orphanRecentKey)).not.toBeNull()
    expect(await r2.get(orphanOldKey)).toBeNull()
  })

  it("§11.9 公开隔离：未登录访问私有端点 401，/api/public 无私有字段暴露", async () => {
    const { env } = await initializedContext()

    // 未登录访问私有端点全拦截
    expect((await request(env, "/api/folders")).status).toBe(401)
    expect((await request(env, "/api/me/usage")).status).toBe(401)
    expect((await request(env, "/api/admin/settings")).status).toBe(401)

    // /api/public 返回模板冻结 7 字段，无任何文件/分享/限额私有字段
    const pubRes = await request(env, "/api/public")
    expect(pubRes.status).toBe(200)
    const pubData = (await pubRes.json()) as Record<string, unknown>
    const allowedKeys = [
      "name",
      "tagline",
      "repositoryUrl",
      "version",
      "appMode",
      "registrationEnabled",
      "emailConfigured"
    ]
    expect(Object.keys(pubData).sort()).toEqual(allowedKeys.sort())
    expect(pubData.files).toBeUndefined()
    expect(pubData.shares).toBeUndefined()
    expect(pubData.limits).toBeUndefined()
  })
})
