import { describe, expect, it } from "vitest"
import {
  DEFAULT_FILE_QUOTA_BYTES,
  DEFAULT_FILE_SINGLE_MAX_BYTES,
  getUserUsageBytes,
  resolveUserLimits,
  validateUploadLimits
} from "../src/core/limits"
import { insertFileRecord } from "../src/db/queries/files"
import { userLimitsTable } from "../src/lib/tables"
import {
  activePrefix,
  initializedContext,
  request,
  seedSession
} from "./support/app"

describe("限额分层与用量（规格 §4）", () => {
  it("无单人配置时回落全局系统设置（未改动时回落 100 MiB 默认值）", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const limits = await resolveUserLimits(env.DB, prefix, user.userId)
    expect(limits.userQuotaBytes).toBeNull()
    expect(limits.userSingleMaxBytes).toBeNull()
    expect(limits.effectiveQuotaBytes).toBe(DEFAULT_FILE_QUOTA_BYTES)
    expect(limits.effectiveSingleMaxBytes).toBe(DEFAULT_FILE_SINGLE_MAX_BYTES)
  })

  it("单人配置覆盖优先，逐项独立回落", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 只覆盖 single_max_bytes = 20 MiB，quota_bytes 留空
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, NULL, ?, ?)`
    )
      .bind(user.userId, 20 * 1024 * 1024, new Date().toISOString())
      .run()

    const limits = await resolveUserLimits(env.DB, prefix, user.userId)
    expect(limits.userQuotaBytes).toBeNull()
    expect(limits.userSingleMaxBytes).toBe(20 * 1024 * 1024)
    // quota_bytes 回落全局
    expect(limits.effectiveQuotaBytes).toBe(DEFAULT_FILE_QUOTA_BYTES)
    // single_max 采用单人覆盖值
    expect(limits.effectiveSingleMaxBytes).toBe(20 * 1024 * 1024)
  })

  it("单人配置单文件上限（如 500 MiB）时按配置生效（已解除 100 MiB 平台硬顶钳制）", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 覆盖单文件上限为 500 MiB
    await env.DB.prepare(
      `INSERT INTO ${userLimitsTable(prefix)} (user_id, quota_bytes, single_max_bytes, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(
        user.userId,
        1000 * 1024 * 1024,
        500 * 1024 * 1024,
        new Date().toISOString()
      )
      .run()

    const limits = await resolveUserLimits(env.DB, prefix, user.userId)
    expect(limits.userSingleMaxBytes).toBe(500 * 1024 * 1024)
    // 实际执行上限不再受 100 MiB 平台硬顶钳制
    expect(limits.effectiveSingleMaxBytes).toBe(500 * 1024 * 1024)
    expect(limits.effectiveQuotaBytes).toBe(1000 * 1024 * 1024)
  })

  it("用量统计仅计算未过期文件，过期文件即刻释放容量", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 插入一个未过期文件（10 MiB）
    await insertFileRecord(env.DB, prefix, {
      id: "f-active",
      userId: user.userId,
      folderId: null,
      name: "active.bin",
      sizeBytes: 10 * 1024 * 1024,
      contentType: "application/octet-stream",
      sha256: null,
      r2Key: `u${user.userId}/f-active`,
      expiresAt: null
    })

    // 插入一个已过期文件（20 MiB）
    await insertFileRecord(env.DB, prefix, {
      id: "f-expired",
      userId: user.userId,
      folderId: null,
      name: "expired.bin",
      sizeBytes: 20 * 1024 * 1024,
      contentType: "application/octet-stream",
      sha256: null,
      r2Key: `u${user.userId}/f-expired`,
      expiresAt: "2020-01-01T00:00:00.000Z"
    })

    const usage = await getUserUsageBytes(env.DB, prefix, user.userId)
    expect(usage).toBe(10 * 1024 * 1024)
  })

  it("校验顺序：①单文件大小 ②总容量；错误码可区分", () => {
    const limits = {
      effectiveSingleMaxBytes: 10 * 1024 * 1024,
      effectiveQuotaBytes: 50 * 1024 * 1024
    }

    // 1. 单文件超限
    const r1 = validateUploadLimits(limits, 0, 15 * 1024 * 1024)
    expect(r1.ok).toBe(false)
    if (!r1.ok) {
      expect(r1.code).toBe("FILE_TOO_LARGE")
      expect(r1.limitBytes).toBe(10 * 1024 * 1024)
      expect(r1.error).toContain("10485760")
    }

    // 2. 单文件合规，但累加后总容量超限
    const r2 = validateUploadLimits(limits, 45 * 1024 * 1024, 8 * 1024 * 1024)
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe("QUOTA_EXCEEDED")
      expect(r2.limitBytes).toBe(50 * 1024 * 1024)
    }

    // 3. 均未超限
    const r3 = validateUploadLimits(limits, 10 * 1024 * 1024, 5 * 1024 * 1024)
    expect(r3.ok).toBe(true)
  })

  it("GET /api/me/usage：登录用户查询自己的生效限额与用量", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 未传文件时用量为 0
    const res1 = await request(env, "/api/me/usage", {
      headers: { cookie: user.cookie }
    })
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({
      usedBytes: 0,
      quotaBytes: DEFAULT_FILE_QUOTA_BYTES,
      singleMaxBytes: DEFAULT_FILE_SINGLE_MAX_BYTES
    })

    // 上传文件后用量更新
    await insertFileRecord(env.DB, prefix, {
      id: "f-1",
      userId: user.userId,
      folderId: null,
      name: "test.bin",
      sizeBytes: 5000,
      contentType: "application/octet-stream",
      sha256: null,
      r2Key: `u${user.userId}/f-1`,
      expiresAt: null
    })

    const res2 = await request(env, "/api/me/usage", {
      headers: { cookie: user.cookie }
    })
    expect(res2.status).toBe(200)
    expect(await res2.json()).toMatchObject({
      usedBytes: 5000,
      quotaBytes: DEFAULT_FILE_QUOTA_BYTES,
      singleMaxBytes: DEFAULT_FILE_SINGLE_MAX_BYTES
    })
  })
})
