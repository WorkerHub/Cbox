import { describe, expect, it } from "vitest"
import { insertFileRecord } from "../src/db/queries/files"
import { createShareRecord } from "../src/db/queries/shares"
import { executeCleanupJob } from "../src/services/scheduled-task"
import { filesTable, sharesTable } from "../src/lib/tables"
import {
  activePrefix,
  adminCookie,
  initializedContext,
  registerUser,
  request,
  seedSession
} from "./support/app"

describe("定时清理与 R2 孤儿对账（规格 §9、§10）", () => {
  it("每轮清理：物理删除过期文件（R2+元数据+分享）与独立过期分享行", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 1. 构造一个已过期文件及其分享
    const expKey = `u${user.userId}/f-exp`
    await r2.put(expKey, "expired-file-content")
    await insertFileRecord(env.DB, prefix, {
      id: "f-exp",
      userId: user.userId,
      folderId: null,
      name: "exp.txt",
      sizeBytes: 20,
      contentType: "text/plain",
      sha256: null,
      r2Key: expKey,
      expiresAt: "2026-01-01T00:00:00.000Z"
    })
    await createShareRecord(env.DB, prefix, user.userId, "f-exp")
    // 强制把分享记录插进去（尽管 createShare 会校验未过期，直接在库里给它造条数据）
    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)} (id, file_id, user_id, token_hash, expires_at, created_at)
       VALUES ('s-exp', 'f-exp', ?, 'hash-exp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
      .bind(user.userId)
      .run()

    // 2. 构造一个有效未过期文件及其分享，以及该文件下一条独立的已过期分享
    const actKey = `u${user.userId}/f-act`
    await r2.put(actKey, "active-file-content")
    await insertFileRecord(env.DB, prefix, {
      id: "f-act",
      userId: user.userId,
      folderId: null,
      name: "act.txt",
      sizeBytes: 19,
      contentType: "text/plain",
      sha256: null,
      r2Key: actKey,
      expiresAt: null // 永不过期
    })
    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)} (id, file_id, user_id, token_hash, expires_at, created_at)
       VALUES ('s-act', 'f-act', ?, 'hash-act', NULL, '2026-01-01T00:00:00.000Z')`
    )
      .bind(user.userId)
      .run()
    await env.DB.prepare(
      `INSERT INTO ${sharesTable(prefix)} (id, file_id, user_id, token_hash, expires_at, created_at)
       VALUES ('s-act-expired', 'f-act', ?, 'hash-act-exp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
      .bind(user.userId)
      .run()

    // 执行清理
    const outcome = await executeCleanupJob(env, {
      now: Math.floor(new Date("2026-06-01T00:00:00.000Z").getTime() / 1000)
    })

    expect(outcome.deletedFiles).toBe(1)
    expect(outcome.deletedShares).toBeGreaterThanOrEqual(1)

    // 过期文件 R2 与 D1 消失
    expect(await r2.get(expKey)).toBeNull()
    const expRow = await env.DB.prepare(
      `SELECT 1 FROM ${filesTable(prefix)} WHERE id = 'f-exp'`
    ).first()
    expect(expRow).toBeNull()

    // 有效文件保留
    expect(await r2.get(actKey)).not.toBeNull()
    const actRow = await env.DB.prepare(
      `SELECT 1 FROM ${filesTable(prefix)} WHERE id = 'f-act'`
    ).first()
    expect(actRow).not.toBeNull()

    // 有效文件的过期分享被删，未过期分享保留
    const sActExpRow = await env.DB.prepare(
      `SELECT 1 FROM ${sharesTable(prefix)} WHERE id = 's-act-expired'`
    ).first()
    expect(sActExpRow).toBeNull()

    const sActRow = await env.DB.prepare(
      `SELECT 1 FROM ${sharesTable(prefix)} WHERE id = 's-act'`
    ).first()
    expect(sActRow).not.toBeNull()
  })

  it("R2 孤儿对账：仅删除 >24h 且无元数据的孤儿对象，保护刚上传或有元数据的对象", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const testNow = new Date("2026-06-10T12:00:00.000Z")
    const testNowSec = Math.floor(testNow.getTime() / 1000)

    // 1. 孤儿 A：早于 24 小时（26 小时前），无 D1 元数据 -> 应被删除
    const orphanOldKey = `u${user.userId}/orphan-old`
    r2.seedObject(
      orphanOldKey,
      "orphan-old",
      new Date(testNow.getTime() - 26 * 3600 * 1000)
    )

    // 2. 临时对象 B：小于 24 小时（1 小时前，可能正在流式上传），无 D1 元数据 -> 应保留
    const orphanYoungKey = `u${user.userId}/orphan-young`
    r2.seedObject(
      orphanYoungKey,
      "orphan-young",
      new Date(testNow.getTime() - 1 * 3600 * 1000)
    )

    // 3. 正常对象 C：早于 24 小时（30 小时前），但 D1 中有元数据 -> 应保留
    const validKey = `u${user.userId}/valid-file`
    r2.seedObject(
      validKey,
      "valid",
      new Date(testNow.getTime() - 30 * 3600 * 1000)
    )
    await insertFileRecord(env.DB, prefix, {
      id: "valid-file",
      userId: user.userId,
      folderId: null,
      name: "valid.txt",
      sizeBytes: 5,
      contentType: "text/plain",
      sha256: null,
      r2Key: validKey,
      expiresAt: null
    })

    const outcome = await executeCleanupJob(env, { now: testNowSec })
    expect(outcome.deletedOrphans).toBe(1)

    expect(await r2.get(orphanOldKey)).toBeNull()
    expect(await r2.get(orphanYoungKey)).not.toBeNull()
    expect(await r2.get(validKey)).not.toBeNull()
  })

  it("POST /api/admin/cleanup：管理员手动触发对账清理", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)

    const res = await request(env, "/api/admin/cleanup", {
      method: "POST",
      headers: { cookie: admin }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      deletedFiles: number
      deletedShares: number
      deletedOrphans: number
    }
    expect(body.success).toBe(true)
    expect(typeof body.deletedFiles).toBe("number")
    expect(typeof body.deletedShares).toBe("number")
    expect(typeof body.deletedOrphans).toBe("number")
  })
})
