import { describe, expect, it } from "vitest"
import { findUserByEmail } from "../src/db/queries/users"
import { usersTable } from "../src/lib/tables"
import {
  activePrefix,
  adminCookie,
  initializedContext,
  memberCookie,
  registerUser,
  request
} from "./support/app"

describe("管理端：全局限额与单人覆盖（规格 §4、§7、§10）", () => {
  it("全局限额并入系统设置既有读写通道 (GET/PUT /api/admin/settings)", async () => {
    const { env } = await initializedContext()
    await registerUser(env, { email: "owner@example.test" })
    const admin = await adminCookie(env)

    // 1. 读取初始默认值：100 MB
    const getRes = await request(env, "/api/admin/settings", {
      headers: { cookie: admin }
    })
    expect(getRes.status).toBe(200)
    const settings = (await getRes.json()) as {
      fileLimits: {
        defaultQuotaMB: number
        defaultSingleMaxMB: number
        defaultQuotaBytes: number
        defaultSingleMaxBytes: number
      }
    }
    expect(settings.fileLimits).toMatchObject({
      defaultQuotaMB: 100,
      defaultSingleMaxMB: 100,
      defaultQuotaBytes: 104857600,
      defaultSingleMaxBytes: 104857600
    })

    // 2. 修改全局限额为总容量 200 MB，单文件上限 10 MB
    const putRes = await request(env, "/api/admin/settings", {
      method: "PUT",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({
        fileLimits: {
          defaultQuotaMB: 200,
          defaultSingleMaxMB: 10
        }
      })
    })
    expect(putRes.status).toBe(200)
    const updated = (await putRes.json()) as {
      fileLimits: { defaultQuotaMB: number; defaultSingleMaxMB: number }
    }
    expect(updated.fileLimits.defaultQuotaMB).toBe(200)
    expect(updated.fileLimits.defaultSingleMaxMB).toBe(10)
  })

  it("PUT /api/admin/users/:id/limits：设置与清空单人覆盖，用户列表带出覆盖值与生效值", async () => {
    const { env } = await initializedContext()
    const prefix = activePrefix(env)
    await registerUser(env, { email: "owner@example.test" })
    await registerUser(env, { email: "user@example.test" })
    await env.DB.prepare(
      `UPDATE ${usersTable(prefix)} SET status = 'active' WHERE email = ?`
    )
      .bind("user@example.test")
      .run()
    const member = await findUserByEmail(env.DB, prefix, "user@example.test")
    if (!member) throw new Error("member not found")
    const admin = await adminCookie(env)
    const normalUserCookie = await memberCookie(env, member.id)

    // 普通用户修改限额 403
    const forbidden = await request(
      env,
      `/api/admin/users/${member.id}/limits`,
      {
        method: "PUT",
        headers: {
          cookie: normalUserCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({ quotaMB: 500 })
      }
    )
    expect(forbidden.status).toBe(403)

    // 管理员给普通用户设置覆盖限额：总容量 300 MB，单文件上限 50 MB
    const setRes = await request(env, `/api/admin/users/${member.id}/limits`, {
      method: "PUT",
      headers: { cookie: admin, "content-type": "application/json" },
      body: JSON.stringify({
        quotaMB: 300,
        singleMaxMB: 50
      })
    })
    expect(setRes.status).toBe(200)
    const setBody = (await setRes.json()) as {
      userId: number
      quotaMB: number
      singleMaxMB: number
      effectiveQuotaMB: number
      effectiveSingleMaxMB: number
    }
    expect(setBody.quotaMB).toBe(300)
    expect(setBody.singleMaxMB).toBe(50)
    expect(setBody.effectiveQuotaMB).toBe(300)
    expect(setBody.effectiveSingleMaxMB).toBe(50)

    // 查询用户列表：应带出该用户的覆盖值与生效值
    const usersRes = await request(env, "/api/admin/users", {
      headers: { cookie: admin }
    })
    expect(usersRes.status).toBe(200)
    const usersList = (await usersRes.json()) as {
      items: Array<{
        id: number
        limits: {
          quotaMB: number | null
          singleMaxMB: number | null
          effectiveQuotaMB: number
          effectiveSingleMaxMB: number
        }
      }>
    }
    const foundUser = usersList.items.find((u) => u.id === member.id)
    expect(foundUser?.limits).toMatchObject({
      quotaMB: 300,
      singleMaxMB: 50,
      effectiveQuotaMB: 300,
      effectiveSingleMaxMB: 50
    })

    // 清空覆盖（传 null）：即刻回落全局默认值（100 MB）
    const clearRes = await request(
      env,
      `/api/admin/users/${member.id}/limits`,
      {
        method: "PUT",
        headers: { cookie: admin, "content-type": "application/json" },
        body: JSON.stringify({
          quotaMB: null,
          singleMaxMB: null
        })
      }
    )
    expect(clearRes.status).toBe(200)
    const clearBody = (await clearRes.json()) as {
      quotaMB: null
      singleMaxMB: null
      effectiveQuotaMB: number
      effectiveSingleMaxMB: number
    }
    expect(clearBody.quotaMB).toBeNull()
    expect(clearBody.singleMaxMB).toBeNull()
    expect(clearBody.effectiveQuotaMB).toBe(100)
    expect(clearBody.effectiveSingleMaxMB).toBe(100)
  })
})
