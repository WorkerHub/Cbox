import { describe, expect, it } from "vitest"
import { createFolder } from "../src/db/queries/folders"
import { insertFileRecord } from "../src/db/queries/files"
import { createShareRecord } from "../src/db/queries/shares"
import { filesTable, foldersTable, sharesTable } from "../src/lib/tables"
import {
  activePrefix,
  initializedContext,
  request,
  seedSession
} from "./support/app"

describe("文件夹 API 与递归删除（规格 §5、§10）", () => {
  it("根目录列表：返回子文件夹、根目录文件、面包屑与用量", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 建两个子文件夹
    await createFolder(env.DB, prefix, user.userId, {
      parentId: null,
      name: "Docs"
    })
    await createFolder(env.DB, prefix, user.userId, {
      parentId: null,
      name: "Pictures"
    })

    // 根目录放一个文件
    await insertFileRecord(env.DB, prefix, {
      id: "f-root",
      userId: user.userId,
      folderId: null,
      name: "readme.txt",
      sizeBytes: 1024,
      contentType: "text/plain",
      sha256: null,
      r2Key: `u${user.userId}/f-root`,
      expiresAt: null
    })

    const res = await request(env, "/api/folders", {
      headers: { cookie: user.cookie }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      folder: null
      breadcrumbs: Array<{ id: string | null; name: string }>
      folders: Array<{ id: string; name: string }>
      files: Array<{ id: string; name: string }>
      usage: { usedBytes: number }
    }

    expect(body.folder).toBeNull()
    expect(body.breadcrumbs).toEqual([{ id: null, name: "root" }])
    expect(body.folders.map((f) => f.name)).toEqual(["Docs", "Pictures"])
    expect(body.files.map((f) => f.name)).toEqual(["readme.txt"])
    expect(body.usage.usedBytes).toBe(1024)
  })

  it("POST /api/folders：建文件夹、名字校验与同父级重名防冲突", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 成功建夹
    const res = await request(env, "/api/folders", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "SubDir" })
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as {
      id: string
      name: string
      parentId: null
    }
    expect(created.name).toBe("SubDir")
    expect(created.parentId).toBeNull()

    // 同级重名拒绝 (409 FOLDER_NAME_CONFLICT)
    const dupRes = await request(env, "/api/folders", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "subdir" }) // case-insensitive check
    })
    expect(dupRes.status).toBe(409)
    expect((await dupRes.json()) as { code: string }).toMatchObject({
      code: "FOLDER_NAME_CONFLICT"
    })

    // 非法文件名拒绝 (包含斜杠)
    const invalidRes = await request(env, "/api/folders", {
      method: "POST",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "a/b" })
    })
    expect(invalidRes.status).toBe(400)
    expect((await invalidRes.json()) as { code: string }).toMatchObject({
      code: "INVALID_FOLDER_NAME"
    })
  })

  it("多级目录与面包屑构建", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    const rootSub = await createFolder(env.DB, prefix, user.userId, {
      parentId: null,
      name: "Level1"
    })
    const childSub = await createFolder(env.DB, prefix, user.userId, {
      parentId: rootSub.id,
      name: "Level2"
    })

    const res = await request(env, `/api/folders?parentId=${childSub.id}`, {
      headers: { cookie: user.cookie }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      breadcrumbs: Array<{ id: string | null; name: string }>
      folder: { id: string; name: string }
    }
    expect(body.breadcrumbs).toEqual([
      { id: null, name: "root" },
      { id: rootSub.id, name: "Level1" },
      { id: childSub.id, name: "Level2" }
    ])
    expect(body.folder.id).toBe(childSub.id)
  })

  it("DELETE /api/folders/:id：递归删除子夹、文件、R2 对象与分享记录", async () => {
    const { env, db, r2 } = await initializedContext()
    const prefix = activePrefix(env)
    const user = await seedSession(db, prefix, { role: "user" })

    // 目录树：Parent -> Child
    const parentFolder = await createFolder(env.DB, prefix, user.userId, {
      parentId: null,
      name: "Parent"
    })
    const childFolder = await createFolder(env.DB, prefix, user.userId, {
      parentId: parentFolder.id,
      name: "Child"
    })

    // 在 Parent 与 Child 分别放一个文件并写入 R2
    const key1 = `u${user.userId}/f-1`
    const key2 = `u${user.userId}/f-2`
    await r2.put(key1, "parent-file-content")
    await r2.put(key2, "child-file-content")

    await insertFileRecord(env.DB, prefix, {
      id: "f-1",
      userId: user.userId,
      folderId: parentFolder.id,
      name: "p.txt",
      sizeBytes: 19,
      contentType: "text/plain",
      sha256: null,
      r2Key: key1,
      expiresAt: null
    })
    await insertFileRecord(env.DB, prefix, {
      id: "f-2",
      userId: user.userId,
      folderId: childFolder.id,
      name: "c.txt",
      sizeBytes: 18,
      contentType: "text/plain",
      sha256: null,
      r2Key: key2,
      expiresAt: null
    })

    // 为 f-1 创建一个分享
    await createShareRecord(env.DB, prefix, user.userId, "f-1")

    // 执行递归删除
    const delRes = await request(env, `/api/folders/${parentFolder.id}`, {
      method: "DELETE",
      headers: { cookie: user.cookie }
    })
    expect(delRes.status).toBe(200)
    const delBody = (await delRes.json()) as {
      success: boolean
      deletedFolders: number
      deletedFiles: number
    }
    expect(delBody.deletedFolders).toBe(2)
    expect(delBody.deletedFiles).toBe(2)

    // R2 中的对象已被删除
    expect(await r2.get(key1)).toBeNull()
    expect(await r2.get(key2)).toBeNull()

    // D1 中的文件夹、文件、分享均已消失
    const remainingFolders = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${foldersTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .first<{ c: number }>()
    expect(remainingFolders?.c).toBe(0)

    const remainingFiles = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${filesTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .first<{ c: number }>()
    expect(remainingFiles?.c).toBe(0)

    const remainingShares = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM ${sharesTable(prefix)} WHERE user_id = ?`
    )
      .bind(user.userId)
      .first<{ c: number }>()
    expect(remainingShares?.c).toBe(0)
  })
})
