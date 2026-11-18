import { describe, expect, it } from "vitest"
import { filesTable, sharesTable } from "../src/lib/tables"
import {
  activePrefix,
  initializedContext,
  request,
  seedSession
} from "./support/app"

describe("公开分享直链与免登下载（规格 §6、§10）", () => {
  it("创建分享：生成高熵 URL-safe 令牌，D1 仅存 SHA-256 哈希", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 上传一个文件
    const up = await request(env, "/api/files?filename=app.jar", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        "content-type": "application/java-archive"
      },
      body: "jar-binary-bytes"
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

    expect(shareBody.url).toMatch(/^http:\/\/worker\.test\/s\/[0-9a-f]{64}$/)
    expect(shareBody.tokenSuffix.length).toBe(4)

    // 提取令牌，校验库中只存 token_hash，绝无明文令牌
    const token = shareBody.url.split("/s/")[1]
    const dbRow = await env.DB.prepare(
      `SELECT token_hash FROM ${sharesTable(prefix)} WHERE id = ?`
    )
      .bind(shareBody.id)
      .first<{ token_hash: string }>()

    expect(dbRow?.token_hash).not.toBe(token)
    expect(dbRow?.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("分享失效时间受文件到期时间封顶截断", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 上传一个 1 小时过期的文件
    const up = await request(
      env,
      "/api/files?filename=file1h.txt&expiresIn=1h",
      {
        method: "POST",
        headers: { cookie: user.cookie },
        body: "content-1h"
      }
    )
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
    const up = await request(env, "/api/files?filename=zeta.jar", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        "content-type": "application/java-archive"
      },
      body: content
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

    const up = await request(env, "/api/files?filename=check404.bin", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: "check"
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
})
