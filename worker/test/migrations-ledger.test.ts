/**
 * 规格 §7-2：迁移账本命名（带前导下划线）、旧账本改名承接与单一 V1 生产只读兼容。
 * 顺带锁住硬约束：基线语句内部不得出现 `;`、表名一律由 tables.ts 拼装。
 */
import { describe, expect, it } from "vitest"
import {
  BASELINE_MIGRATION,
  FILES_UPLOADS_MIGRATION,
  SHARES_TOKEN_MIGRATION,
  getMigrations
} from "../src/lib/migrations"
import { splitStatements } from "../src/lib/migrations-runner"
import { ledgerName, runSetup } from "../src/lib/setup"
import {
  emailCodesTable,
  filesTable,
  legacyMigrationsTable,
  migrationsTable,
  sessionsTable,
  settingsTable,
  sharesTable,
  user2faTable,
  usersTable
} from "../src/lib/tables"
import { activePrefix, initializedContext, tableNames } from "./support/app"
import type { SqliteD1 } from "./support/sqlite-d1"

/** 表当前的列名（按表定义顺序）。 */
function columnNames(db: SqliteD1, table: string): string[] {
  return db.db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .map((column) => column.name)
}

describe("迁移定义", () => {
  it("单一基线 schema_v1 与直传增量迁移，语句内部不含分号", () => {
    const prefix = "wiki_"
    const migrations = getMigrations(prefix)
    expect(migrations.map((migration) => migration.name)).toEqual([
      BASELINE_MIGRATION,
      FILES_UPLOADS_MIGRATION,
      SHARES_TOKEN_MIGRATION
    ])
    for (const migration of migrations) {
      const statements = splitStatements(migration.sql)
      for (const statement of statements) {
        expect(statement).not.toContain(";")
      }
    }
    // 基线迁移建表与索引
    for (const statement of splitStatements(migrations[0].sql)) {
      expect(statement.startsWith("CREATE")).toBe(true)
    }
  })

  it("表名一律带生效前缀（没有任何无前缀表名）", () => {
    const prefix = "wiki_"
    const [migration] = getMigrations(prefix)
    for (const statement of splitStatements(migration.sql)) {
      const tableMatch = statement.match(/CREATE TABLE IF NOT EXISTS (\S+)/)
      if (tableMatch) {
        expect(tableMatch[1].startsWith(prefix)).toBe(true)
      }
    }
  })

  it("无前缀时表名就是逻辑名", () => {
    const sql = getMigrations("")[0].sql
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS users")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS system_settings")
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS _")
  })
})

describe("账本命名", () => {
  it("带前缀：账本带前导下划线，旧版无下划线的名字不会被建出来", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    expect(ledgerName(prefix)).toBe(`_${prefix}schema_migrations`)
    expect(ledgerName(prefix)).toBe(migrationsTable(prefix))

    const tables = tableNames(db)
    expect(tables).toContain(migrationsTable(prefix))
    expect(tables).not.toContain(legacyMigrationsTable(prefix))
  })

  it("无前缀：账本名是 _schema_migrations", async () => {
    const { db } = await initializedContext({ TABLE_PREFIX: "" })
    expect(ledgerName("")).toBe("_schema_migrations")
    expect(tableNames(db)).toContain("_schema_migrations")
  })

  it("重复 setup 只做幂等检查：全部 skipped", async () => {
    const { env } = await initializedContext()
    const again = await runSetup(env)
    expect(again.success).toBe(true)
    if (again.success) {
      expect(again.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "skipped" },
        { name: SHARES_TOKEN_MIGRATION, status: "skipped" }
      ])
    }
  })
})

describe("旧账本改名承接", () => {
  it("旧账本在、新账本不在 → 改名承接，已应用记录保留，迁移全部 skipped", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const legacy = legacyMigrationsTable(prefix)

    // 模拟旧版账本形态：把新账本改名回旧名字。
    db.db.exec(`ALTER TABLE ${migrationsTable(prefix)} RENAME TO ${legacy}`)
    expect(tableNames(db)).toContain(legacy)
    expect(tableNames(db)).not.toContain(migrationsTable(prefix))

    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "skipped" },
        { name: SHARES_TOKEN_MIGRATION, status: "skipped" }
      ])
    }

    const tables = tableNames(db)
    expect(tables).toContain(migrationsTable(prefix))
    expect(tables).not.toContain(legacy)

    const rows = db.db
      .prepare(`SELECT name FROM ${migrationsTable(prefix)}`)
      .all() as Array<{ name: string }>
    expect(new Set(rows.map((row) => row.name))).toEqual(
      new Set([
        BASELINE_MIGRATION,
        FILES_UPLOADS_MIGRATION,
        SHARES_TOKEN_MIGRATION
      ])
    )
  })

  it("新旧账本同存 → 409 LEDGER_CONFLICT，一个表都不动", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    db.db.exec(
      `CREATE TABLE ${legacyMigrationsTable(prefix)} (name TEXT PRIMARY KEY)`
    )
    const before = tableNames(db)

    const result = await runSetup(env)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe("LEDGER_CONFLICT")
      expect(result.error).toContain(legacyMigrationsTable(prefix))
    }
    expect(tableNames(db)).toEqual(before)
    expect(tableNames(db)).toContain(legacyMigrationsTable(prefix))
  })

  it("旧账本没有 name 列（别人的表）→ 409，绝不改名", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const legacy = legacyMigrationsTable(prefix)
    db.db.exec(`ALTER TABLE ${migrationsTable(prefix)} RENAME TO ${legacy}`)
    db.db.exec(`ALTER TABLE ${legacy} RENAME TO ${legacy}_old`)
    db.db.exec(`CREATE TABLE ${legacy} (id TEXT PRIMARY KEY)`)

    const result = await runSetup(env)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe("LEDGER_CONFLICT")
    }
    expect(
      db.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
        )
        .get(legacy)
    ).toBeTruthy()
    expect(tableNames(db)).not.toContain(migrationsTable(prefix))
    expect(tableNames(db)).toContain(usersTable(prefix))
    expect(tableNames(db)).toContain(settingsTable(prefix))
    expect(tableNames(db)).toContain(sessionsTable(prefix))
  })
})

describe("生产库增量升级与兼容（存量已应用 v1..v6）", () => {
  it("生产库已有 schema_v1..schema_v6 记录：基线 skipped，增量 files_uploads_v1 applied，存量数据保留", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const ledger = migrationsTable(prefix)
    const users = usersTable(prefix)
    const files = filesTable(prefix)
    const shares = sharesTable(prefix)
    const now = new Date().toISOString()

    // 模拟生产库状态：账本拥有历史 v1..v6 应用记录（尚未应用 files_uploads_v1 与 shares_token_v1）
    const legacyRecords = [
      "schema_v1",
      "schema_v2",
      "schema_v3",
      "schema_v4",
      "schema_v5",
      "schema_v6"
    ]
    db.db.exec(`DELETE FROM ${ledger}`)
    for (const name of legacyRecords) {
      db.db
        .prepare(`INSERT INTO ${ledger} (name, applied_at) VALUES (?, ?)`)
        .run(name, Math.floor(Date.now() / 1000))
    }

    // 生产既有测试账号
    db.db
      .prepare(
        `INSERT INTO ${users}
          (email, password_hash, role, status, email_verified, language,
           display_name, timezone, created_at, updated_at, must_change_password)
         VALUES (?, 'hash', 'admin', 'active', 1, 'zh', 'ProdAdmin', 'Asia/Shanghai', ?, ?, 0)`
      )
      .run("prod-admin@example.test", now, now)

    // 模拟存量 files 表如果缺少 status / upload_id 列，shares 表缺少 token 列
    db.db.exec(`ALTER TABLE ${files} DROP COLUMN status`)
    db.db.exec(`ALTER TABLE ${files} DROP COLUMN upload_id`)
    db.db.exec(`ALTER TABLE ${shares} DROP COLUMN token`)
    expect(columnNames(db, files)).not.toContain("status")
    expect(columnNames(db, files)).not.toContain("upload_id")
    expect(columnNames(db, shares)).not.toContain("token")

    // 执行 setup / 数据库维护升级
    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      // 基线 schema_v1 被识别为 skipped，增量 files_uploads_v1 与 shares_token_v1 成功 applied
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "applied" },
        { name: SHARES_TOKEN_MIGRATION, status: "applied" }
      ])
    }

    // 校验 files 表成功补全两列，shares 表成功补全 token 列
    expect(columnNames(db, files)).toContain("status")
    expect(columnNames(db, files)).toContain("upload_id")
    expect(columnNames(db, shares)).toContain("token")

    // 既有测试账号完整保留
    const userRow = db.db
      .prepare(
        `SELECT email, display_name, role, status FROM ${users} WHERE email = ?`
      )
      .get("prod-admin@example.test")
    expect(userRow).toEqual({
      email: "prod-admin@example.test",
      display_name: "ProdAdmin",
      role: "admin",
      status: "active"
    })

    // 再次执行 setup：三项迁移均 skipped（幂等）
    const secondResult = await runSetup(env)
    expect(secondResult.success).toBe(true)
    if (secondResult.success) {
      expect(secondResult.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "skipped" },
        { name: SHARES_TOKEN_MIGRATION, status: "skipped" }
      ])
    }
  })

  it("生产库已有 schema_v1 与 files_uploads_v1 记录：前两项 skipped，增量 shares_token_v1 applied，存量分享数据保留", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const ledger = migrationsTable(prefix)
    const shares = sharesTable(prefix)
    const files = filesTable(prefix)
    const users = usersTable(prefix)
    const now = new Date().toISOString()

    // 模拟生产库状态：账本已有 schema_v1 与 files_uploads_v1
    db.db.exec(`DELETE FROM ${ledger}`)
    for (const name of [BASELINE_MIGRATION, FILES_UPLOADS_MIGRATION]) {
      db.db
        .prepare(`INSERT INTO ${ledger} (name, applied_at) VALUES (?, ?)`)
        .run(name, Math.floor(Date.now() / 1000))
    }

    // 创建测试用户与文件
    db.db
      .prepare(
        `INSERT INTO ${users}
          (id, email, password_hash, role, status, email_verified, language,
           display_name, timezone, created_at, updated_at, must_change_password)
         VALUES (999, 'user@example.test', 'hash', 'user', 'active', 1, 'zh', 'User', 'Asia/Shanghai', ?, ?, 0)`
      )
      .run(now, now)
    db.db
      .prepare(
        `INSERT INTO ${files}
          (id, user_id, name, size_bytes, content_type, r2_key, status, created_at)
         VALUES ('file-999', 999, 'test.txt', 10, 'text/plain', 'u999/file-999', 'active', ?)`
      )
      .run(now)

    // 模拟存量 shares 表缺少 token 列
    db.db.exec(`ALTER TABLE ${shares} DROP COLUMN token`)
    expect(columnNames(db, shares)).not.toContain("token")

    // 插入一条存量分享（只有 token_hash，无 token 列）
    db.db
      .prepare(
        `INSERT INTO ${shares}
          (id, file_id, user_id, token_hash, download_count, created_at)
         VALUES ('share-legacy', 'file-999', 999, 'legacy-hash', 5, ?)`
      )
      .run(now)

    // 执行 setup 数据库维护升级
    const result = await runSetup(env)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "skipped" },
        { name: SHARES_TOKEN_MIGRATION, status: "applied" }
      ])
    }

    // 校验 shares 表补全 token 列，且存量记录的 token 为 null
    expect(columnNames(db, shares)).toContain("token")
    const legacyRow = db.db
      .prepare(
        `SELECT id, token, token_hash, download_count FROM ${shares} WHERE id = 'share-legacy'`
      )
      .get<{
        id: string
        token: string | null
        token_hash: string
        download_count: number
      }>()
    expect(legacyRow?.token).toBeNull()
    expect(legacyRow?.token_hash).toBe("legacy-hash")
    expect(legacyRow?.download_count).toBe(5)

    // 再次执行 setup：全部 skipped 幂等
    const secondResult = await runSetup(env)
    expect(secondResult.success).toBe(true)
    if (secondResult.success) {
      expect(secondResult.migrations).toEqual([
        { name: BASELINE_MIGRATION, status: "skipped" },
        { name: FILES_UPLOADS_MIGRATION, status: "skipped" },
        { name: SHARES_TOKEN_MIGRATION, status: "skipped" }
      ])
    }
  })
})

describe("单一 V1 终态表结构验证（全新安装）", () => {
  it("shares 表：包含 token 列", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const columns = columnNames(db, sharesTable(prefix))
    expect(columns).toContain("token")
  })

  it("files 表：包含 status 与 upload_id 列", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const columns = columnNames(db, filesTable(prefix))
    expect(columns).toContain("status")
    expect(columns).toContain("upload_id")
  })

  it("users 表：无 username、无 theme、有 must_change_password", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const columns = columnNames(db, usersTable(prefix))
    expect(columns).not.toContain("username")
    expect(columns).not.toContain("theme")
    expect(columns).toContain("must_change_password")
  })

  it("user_2fa 表：有 email_2fa_enabled", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const columns = columnNames(db, user2faTable(prefix))
    expect(columns).toContain("email_2fa_enabled")
  })

  it("email_verification_codes 表：CHECK 约束支持三值", async () => {
    const { env, db } = await initializedContext()
    const prefix = activePrefix(env)
    const codes = emailCodesTable(prefix)
    const now = Math.floor(Date.now() / 1000)

    // 三个目的均能成功插入
    for (const purpose of ["register_verify", "password_reset", "email_2fa"]) {
      db.db
        .prepare(
          `INSERT INTO ${codes} (email, purpose, code_hash, expires_at, created_at)
           VALUES (?, ?, 'hash', ?, ?)`
        )
        .run(`test-${purpose}@example.test`, purpose, now + 600, now)
    }

    // 非法目的触发 CHECK 失败
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO ${codes} (email, purpose, code_hash, expires_at, created_at)
           VALUES ('bad@example.test', 'invalid_purpose', 'hash', ?, ?)`
        )
        .run(now + 600, now)
    ).toThrow(/CHECK/i)
  })
})
