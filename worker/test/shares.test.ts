import { describe, expect, it } from "vitest"
import { sha256Hex } from "../src/core/auth"
import { createShareRecord, generateShareToken } from "../src/db/queries/shares"
import { filesTable, sharesTable } from "../src/lib/tables"
import {
  activePrefix,
  directUpload,
  initializedContext,
  postJson,
  request,
  seedSession
} from "./support/app"

describe("公开分享直链与免登下载（规格 §6、§10）", () => {
  it("创建分享：生成高熵 URL-safe 令牌，D1 仅存 SHA-256 哈希", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 上传一个文件
    const up = await directUpload(env, user.cookie, {
      filename: "app.jar",
      contentType: "application/java-archive",
      content: "jar-binary-bytes"
    })
    const file = (await up.json()) as { id: string }

    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "24h" })
    })

    expect(shareRes.status).toBe(201)
    const shareBody = (await shareRes.json()) as {
      id: string
      url: string
      expires_at: string
      tokenSuffix: string
    }

    expect(shareBody.url).toMatch(/^http:\/\/worker\.test\/s\/[A-Za-z0-9]{8}$/)
    expect(shareBody.tokenSuffix.length).toBe(4)

    // 提取令牌，校验库中同时存 token（明文）与 token_hash（哈希），且 token_hash 符合 SHA-256
    const token = shareBody.url.split("/s/")[1]
    const dbRow = await env.DB.prepare(
      `SELECT token, token_hash FROM ${sharesTable(prefix)} WHERE id = ?`
    )
      .bind(shareBody.id)
      .first<{ token: string; token_hash: string }>()

    expect(dbRow?.token).toBe(token)
    expect(dbRow?.token_hash).not.toBe(token)
    expect(dbRow?.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("分享失效时间受文件到期时间封顶截断", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 上传一个 1 小时过期的文件
    const up = await directUpload(env, user.cookie, {
      filename: "file1h.txt",
      expiresIn: "1h",
      content: "content-1h"
    })
    const file = (await up.json()) as { id: string; expiresAt: string }

    // 申请创建 7 天有效期的分享
    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "7d" })
    })
    expect(shareRes.status).toBe(201)
    const share = (await shareRes.json()) as { expires_at: string }

    // 分享的 expires_at 被封顶截断到文件的 expires_at
    expect(share.expires_at).toBe(file.expiresAt)
  })

  it("GET /s/:token：免登录免 Cookie 直出 200 与附件下载，禁止跳转", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "public-zeta-jar-stream-content"
    const up = await directUpload(env, user.cookie, {
      filename: "zeta.jar",
      contentType: "application/java-archive",
      content
    })
    const file = (await up.json()) as { id: string }

    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    const share = (await shareRes.json()) as { id: string; url: string }
    const token = share.url.split("/s/")[1]

    // 未登录匿名发起 GET /s/:token
    const downloadRes = await request(env, `/s/${token}`)
    expect(downloadRes.status).toBe(200)
    expect(downloadRes.headers.get("content-type")).toBe(
      "application/java-archive"
    )
    expect(downloadRes.headers.get("content-disposition")).toBe(
      "attachment; filename=\"zeta.jar\"; filename*=UTF-8''zeta.jar"
    )
    expect(downloadRes.headers.get("content-length")).toBe(
      String(content.length)
    )
    expect(downloadRes.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await downloadRes.text()).toBe(content)

    // 成功下载更新计数与最近下载时间
    const listRes = await request(env, `/api/files/${file.id}/shares`, {
      headers: { cookie: user.cookie }
    })
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as {
      items: Array<{
        id: string
        downloadCount: number
        lastDownloadedAt: string | null
      }>
    }
    const found = list.items.find((item) => item.id === share.id)
    expect(found?.downloadCount).toBe(1)
    expect(found?.lastDownloadedAt).not.toBeNull()
  })

  it("过期、撤销、文件已删或文件已过期一律 404（无密码校验环节）", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const up = await directUpload(env, user.cookie, {
      filename: "check404.bin",
      content: "check"
    })
    const file = (await up.json()) as { id: string }

    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "24h" })
    })
    const share = (await shareRes.json()) as { id: string; url: string }
    const token = share.url.split("/s/")[1]

    // 1. 撤销分享 (DELETE /api/shares/:id) 即刻 404
    const delShare = await request(env, `/api/shares/${share.id}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(delShare.status).toBe(200)
    expect((await request(env, `/s/${token}`)).status).toBe(404)

    // 2. 重新建一个分享，修改分享过期时间为过去，访问回 404
    const share2 = (await (
      await request(env, `/api/files/${file.id}/shares`, {
        method: "POST",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "24h" })
      })
    ).json()) as { id: string; url: string }
    const token2 = share2.url.split("/s/")[1]

    await env.DB.prepare(
      `UPDATE ${sharesTable(prefix)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(share2.id)
      .run()
    expect((await request(env, `/s/${token2}`)).status).toBe(404)

    // 3. 重新建一个分享，修改所属文件为已过期，访问回 404
    const share3 = (await (
      await request(env, `/api/files/${file.id}/shares`, {
        method: "POST",
        headers: { cookie: user.cookie, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: "24h" })
      })
    ).json()) as { id: string; url: string }
    const token3 = share3.url.split("/s/")[1]

    await env.DB.prepare(
      `UPDATE ${filesTable(prefix)} SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(file.id)
      .run()
    expect((await request(env, `/s/${token3}`)).status).toBe(404)
  })

  it("空 token /s/ 与非法形态一律回 404，不落 SPA 200 回落", async () => {
    const { env } = await initializedContext()

    // 1. GET /s 与 GET /s/ 均显式返回 404，不落 SPA 200
    const resNoSlash = await request(env, "/s")
    expect(resNoSlash.status).toBe(404)
    expect(await resNoSlash.text()).toBe("Not found")

    const resSlash = await request(env, "/s/")
    expect(resSlash.status).toBe(404)
    expect(await resSlash.text()).toBe("Not found")

    // 2. 空白 token 或多斜杠形态回 404
    const resWhitespace = await request(env, "/s/%20")
    expect(resWhitespace.status).toBe(404)
    expect(await resWhitespace.text()).toBe("Not found")

    const resMultiSlash = await request(env, "/s//")
    expect(resMultiSlash.status).toBe(404)
    expect(await resMultiSlash.text()).toBe("Not found")

    // 3. 多段路径 /s/token/extra 回 404
    const resMultiSegment = await request(env, "/s/some-token/extra")
    expect(resMultiSegment.status).toBe(404)
    expect(await resMultiSegment.text()).toBe("Not found")
  })

  it("验收 1：新建分享令牌恰为 8 位、字符在 [A-Za-z0-9] 内；连续创建无重复且包含高熵拒绝采样", () => {
    // 连续生成 1000 个令牌
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const tok = generateShareToken()
      expect(tok).toHaveLength(8)
      expect(tok).toMatch(/^[A-Za-z0-9]{8}$/)
      tokens.add(tok)
    }
    // 1000 个令牌全部唯一
    expect(tokens.size).toBe(1000)

    // 验证拒绝采样：byte >= 248 会被拒绝，正确采样到对应字符
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto)
    try {
      // 故意提供含 >= 248 的 byte 序列，测试拒绝采样无偏性
      crypto.getRandomValues = ((buf: Uint8Array) => {
        // [250(弃), 0('a'), 251(弃), 1('b'), 252(弃), 2('c'), 253(弃), 3('d'),
        //  254(弃), 4('e'), 255(弃), 5('f'), 250(弃), 6('g'), 251(弃), 7('h')]
        const sequence = [
          250, 0, 251, 1, 252, 2, 253, 3, 254, 4, 255, 5, 250, 6, 251, 7
        ]
        for (let i = 0; i < buf.length && i < sequence.length; i++) {
          buf[i] = sequence[i]
        }
        return buf
      }) as typeof crypto.getRandomValues

      const token = generateShareToken()
      expect(token).toBe("abcdefgh")
    } finally {
      crypto.getRandomValues = originalGetRandomValues
    }
  })

  it("验收 2：上传选 7d 与永不过期，complete 响应带 share 字段且链接可免登直下", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 上传选 7d 有效期
    const content7d = "content-for-7d-share"
    const up7d = await directUpload(env, user.cookie, {
      filename: "test-7d.txt",
      expiresIn: "7d",
      content: content7d
    })
    expect(up7d.status).toBe(200)
    const file7d = (await up7d.json()) as {
      id: string
      expiresAt: string
      share?: { token: string; expiresAt: string | null }
    }
    expect(file7d.share).toBeDefined()
    expect(file7d.share?.token).toHaveLength(8)
    expect(file7d.share?.token).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(file7d.share?.expiresAt).toBe(file7d.expiresAt)

    // GET /s/<token> 匿名免登下载
    const dl7d = await request(env, `/s/${file7d.share?.token}`)
    expect(dl7d.status).toBe(200)
    expect(await dl7d.text()).toBe(content7d)

    // 2. 上传选永不过期 (never)
    const contentNever = "content-for-never-share"
    const upNever = await directUpload(env, user.cookie, {
      filename: "test-never.txt",
      expiresIn: "never",
      content: contentNever
    })
    expect(upNever.status).toBe(200)
    const fileNever = (await upNever.json()) as {
      id: string
      expiresAt: string | null
      share?: { token: string; expiresAt: string | null }
    }
    expect(fileNever.expiresAt).toBeNull()
    expect(fileNever.share).toBeDefined()
    expect(fileNever.share?.token).toHaveLength(8)
    expect(fileNever.share?.expiresAt).toBeNull()

    // GET /s/<token> 匿名免登下载
    const dlNever = await request(env, `/s/${fileNever.share?.token}`)
    expect(dlNever.status).toBe(200)
    expect(await dlNever.text()).toBe(contentNever)
  })

  it("验收 3：存量 64 位十六进制令牌的旧链接仍可正常免登下载", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const content = "legacy-64-hex-token-content"
    const up = await directUpload(env, user.cookie, {
      filename: "legacy.txt",
      content
    })
    const file = (await up.json()) as { id: string }

    // 构造一条存量 64 位十六进制 token 记录
    const legacyToken =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const legacyHash = await sha256Hex(legacyToken)
    const shareId = crypto.randomUUID()
    const now = new Date().toISOString()

    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)}
        (id, file_id, user_id, token_hash, expires_at, download_count, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, ?)`
    )
      .bind(shareId, file.id, user.userId, legacyHash, now)
      .run()

    // 用 64 位十六进制旧令牌请求 /s/:token
    const dl = await request(env, `/s/${legacyToken}`)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe(content)
  })

  it("验收 4：手动分享默认「跟随文件」，建出分享到期与文件一致；改选 1h 受文件到期封顶", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 上传一个 7 天有效期的文件
    const up = await directUpload(env, user.cookie, {
      filename: "test-manual-file.txt",
      expiresIn: "7d",
      content: "content"
    })
    const file = (await up.json()) as { id: string; expiresAt: string }

    // 不传 expiresIn：默认「跟随文件」
    const shareDefault = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({})
    })
    expect(shareDefault.status).toBe(201)
    const bodyDefault = (await shareDefault.json()) as { expires_at: string }
    expect(bodyDefault.expires_at).toBe(file.expiresAt)

    // 显式传 expiresIn: "file"：跟随文件
    const shareFile = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "file" })
    })
    expect(shareFile.status).toBe(201)
    const bodyFile = (await shareFile.json()) as { expires_at: string }
    expect(bodyFile.expires_at).toBe(file.expiresAt)

    // 改选 1h：约为 1 小时后，且不晚于文件到期时间
    const share1h = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    expect(share1h.status).toBe(201)
    const body1h = (await share1h.json()) as { expires_at: string }
    expect(body1h.expires_at).not.toBe(file.expiresAt)
    expect(new Date(body1h.expires_at).getTime()).toBeLessThan(
      new Date(file.expiresAt).getTime()
    )
    const oneHourFromNow = Date.now() + 3600 * 1000
    expect(
      Math.abs(new Date(body1h.expires_at).getTime() - oneHourFromNow)
    ).toBeLessThan(10000)

    // 2. 上传一个即将到期（例如 10 分钟后到期）的文件，改选 1h 受文件有效期封顶截断
    const tenMinIso = new Date(Date.now() + 600 * 1000).toISOString()
    const upShort = await directUpload(env, user.cookie, {
      filename: "short.txt",
      expiresIn: "1h",
      content: "short"
    })
    const fileShort = (await upShort.json()) as { id: string }
    await env.DB.prepare(
      `UPDATE ${filesTable(prefix)} SET expires_at = ? WHERE id = ?`
    )
      .bind(tenMinIso, fileShort.id)
      .run()

    const shareShort = await request(env, `/api/files/${fileShort.id}/shares`, {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "1h" })
    })
    expect(shareShort.status).toBe(201)
    const bodyShort = (await shareShort.json()) as { expires_at: string }
    expect(bodyShort.expires_at).toBe(tenMinIso)
  })

  it("验收 6：自动分享创建失败时上传仍成功（响应不带 share 字段）", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 初始化上传任务
    const content = new TextEncoder().encode("auto-share-fail-test")
    const initRes = await postJson(
      env,
      "/api/files/uploads/init",
      {
        filename: "fail-share.txt",
        declaredSizeBytes: content.byteLength
      },
      { cookie: user.cookie }
    )
    expect(initRes.status).toBe(201)
    const initData = (await initRes.json()) as {
      uploadId: string
      url: string
    }

    // 2. PUT 到存储
    const doFetch = env.S3_FETCH ?? fetch
    await doFetch(initData.url, {
      method: "PUT",
      body: content
    })

    // 3. 模拟 shares 表操作失败（例如库抛出异常）
    const originalPrepare = env.DB.prepare.bind(env.DB)
    env.DB.prepare = (sql: string) => {
      if (sql.includes(sharesTable(prefix))) {
        throw new Error("Simulated D1 error when inserting share")
      }
      return originalPrepare(sql)
    }

    try {
      // 4. 调用 complete
      const completeRes = await postJson(
        env,
        `/api/files/uploads/${initData.uploadId}/complete`,
        {},
        { cookie: user.cookie }
      )
      expect(completeRes.status).toBe(200)
      const completeBody = (await completeRes.json()) as {
        id: string
        share?: unknown
      }
      expect(completeBody.id).toBe(initData.uploadId)
      // 响应中不得带 share 字段
      expect(completeBody.share).toBeUndefined()

      // 验证文件记录依然成功激活
      const fileRow = await originalPrepare(
        `SELECT status FROM ${filesTable(prefix)} WHERE id = ?`
      )
        .bind(initData.uploadId)
        .first<{ status: string }>()
      expect(fileRow?.status).toBe("active")
    } finally {
      env.DB.prepare = originalPrepare
    }
  })

  it("规格 §1：插入遇 token_hash 唯一冲突时重新生成并重试，最多 3 次，仍冲突则报错", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const up = await directUpload(env, user.cookie, {
      filename: "collision-test.txt",
      content: "collision"
    })
    const file = (await up.json()) as { id: string }

    // 先插入一条分享，占住 tokenA ("aaaaaaaa")
    const tokenA = "aaaaaaaa"
    const tokenB = "bbbbbbbb"
    const tokenAHash = await sha256Hex(tokenA)
    const now = new Date().toISOString()

    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)}
        (id, file_id, user_id, token_hash, expires_at, download_count, created_at)
       VALUES ('s-exist', ?, ?, ?, NULL, 0, ?)`
    )
      .bind(file.id, user.userId, tokenAHash, now)
      .run()

    const originalGetRandomValues = crypto.getRandomValues.bind(crypto)

    // 情况 1：第 1 次冲突生成 tokenA，第 1 次重试生成 tokenB 成功
    let calls = 0
    try {
      crypto.getRandomValues = ((buf: Uint8Array) => {
        calls++
        // 第 1 次调用全为 0 -> 'a'，第 2 次调用全为 1 -> 'b'
        const byte = calls === 1 ? 0 : 1
        buf.fill(byte)
        return buf
      }) as typeof crypto.getRandomValues

      const res = await createShareRecord(
        env.DB,
        prefix,
        user.userId,
        file.id,
        "file"
      )
      expect(res).not.toBeNull()
      expect(res?.token).toBe(tokenB)
      expect(calls).toBe(2)
    } finally {
      crypto.getRandomValues = originalGetRandomValues
    }

    // 情况 2：所有尝试均冲突（第 1 次 + 3 次重试共 4 次），重试耗尽后抛错
    calls = 0
    try {
      crypto.getRandomValues = ((buf: Uint8Array) => {
        calls++
        // 每次都生成 tokenA，恒冲突
        buf.fill(0)
        return buf
      }) as typeof crypto.getRandomValues

      await expect(
        createShareRecord(env.DB, prefix, user.userId, file.id, "file")
      ).rejects.toThrow(/UNIQUE constraint failed/i)
      // 初始 1 次 + 重试 3 次 = 4 次尝试
      expect(calls).toBe(4)
    } finally {
      crypto.getRandomValues = originalGetRandomValues
    }
  })

  it("分享列表：每条返回明文 token（存量旧分享为 null），tokenSuffix 从列表中移除，仅所有者登录态可读", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const userA = await seedSession(db, prefix, {
      role: "user",
      email: "usera@example.test"
    })
    const userB = await seedSession(db, prefix, {
      role: "user",
      email: "userb@example.test"
    })

    // userA 上传文件
    const up = await directUpload(env, userA.cookie, {
      filename: "shared-doc.pdf",
      content: "pdf-content"
    })
    const file = (await up.json()) as { id: string }

    // 1. 创建新分享（带明文 token）
    const shareRes = await request(env, `/api/files/${file.id}/shares`, {
      method: "POST",
      headers: { cookie: userA.cookie, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: "24h" })
    })
    expect(shareRes.status).toBe(201)
    const shareBody = (await shareRes.json()) as { id: string; url: string }
    const newToken = shareBody.url.split("/s/")[1]

    // 2. 手动插入一条存量旧分享（token 为 NULL）
    const legacyToken = "legacy88"
    const legacyHash = await sha256Hex(legacyToken)
    const legacyShareId = crypto.randomUUID()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)}
        (id, file_id, user_id, token, token_hash, expires_at, download_count, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, 0, ?)`
    )
      .bind(legacyShareId, file.id, userA.userId, legacyHash, now)
      .run()

    // 3. 所有者 userA 获取分享列表
    const listRes = await request(env, `/api/files/${file.id}/shares`, {
      headers: { cookie: userA.cookie }
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as {
      items: Array<{
        id: string
        fileId: string
        token: string | null
        tokenSuffix?: string
        expiresAt: string | null
        downloadCount: number
        lastDownloadedAt: string | null
        createdAt: string
        expired: boolean
      }>
    }

    // directUpload 自动创建 1 条 + POST 手动创建 1 条 + 存量注入 1 条 = 3 条
    expect(listBody.items.length).toBe(3)

    // 新手动创建分享：返回明文 token，不含 tokenSuffix
    const newShareItem = listBody.items.find((item) => item.id === shareBody.id)
    expect(newShareItem).toBeDefined()
    expect(newShareItem?.token).toBe(newToken)
    expect(newShareItem).not.toHaveProperty("tokenSuffix")

    // 上传直传自动创建的分享：同样持久化了明文 token，且不含 tokenSuffix
    const autoShareItem = listBody.items.find(
      (item) => item.id !== shareBody.id && item.id !== legacyShareId
    )
    expect(autoShareItem).toBeDefined()
    expect(autoShareItem?.token).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(autoShareItem).not.toHaveProperty("tokenSuffix")

    // 存量旧分享：token 为 null，不含 tokenSuffix
    const legacyShareItem = listBody.items.find(
      (item) => item.id === legacyShareId
    )
    expect(legacyShareItem).toBeDefined()
    expect(legacyShareItem?.token).toBeNull()
    expect(legacyShareItem).not.toHaveProperty("tokenSuffix")

    // 4. 免登下载 /s/:token：新旧两种 token 均能按哈希正常下载
    const dlNew = await request(env, `/s/${newToken}`)
    expect(dlNew.status).toBe(200)
    expect(await dlNew.text()).toBe("pdf-content")

    const dlLegacy = await request(env, `/s/${legacyToken}`)
    expect(dlLegacy.status).toBe(200)
    expect(await dlLegacy.text()).toBe("pdf-content")

    // 5. 权限隔离：其他用户 userB 无法读取该文件的分享列表
    const forbidRes = await request(env, `/api/files/${file.id}/shares`, {
      headers: { cookie: userB.cookie }
    })
    expect(forbidRes.status).toBe(404)

    // 6. 权限隔离：未登录访问分享列表 401
    const unauthRes = await request(env, `/api/files/${file.id}/shares`)
    expect(unauthRes.status).toBe(401)
  })
})
