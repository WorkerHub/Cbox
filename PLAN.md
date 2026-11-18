# Cbox 后端：S3 直传改造 —— 实施计划

## 一、两个「二选一」定稿

### 决策 1：SigV4 实现方式 = `aws4fetch`（不自实现）

**理由**（舰队纪律 §3「依赖优先，不手搓等价组件」）：
- `aws4fetch@1.0.20`（MIT）原生支持我们需要的全部能力，已实测验证：
  - `client.sign(url, { method, headers, aws: { signQuery: true, allHeaders: true } })` 产出预签名 URL；设置 `allHeaders: true` 会把 `content-length` / `content-type` 纳入签名（默认在 `UNSIGNABLE_HEADERS` 里被跳过）——这正是 single PUT「签名绑定 Content-Length」所需。
  - 分片预签名：URL 上携带 `partNumber` + `uploadId` 查询参数即可正确签名。
  - `client.fetch(...)` 对 Create/Complete/AbortMultipartUpload 的 XML 请求自动添加 `Authorization` 请求头，且自动设置 `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`。
- 自实现 SigV4（WebCrypto HMAC）是重造已成熟组件，违反团队纪律，且增加额外的维护成本和安全测试面。

### 决策 2：pending 状态落法 = `files` 表加 `status` 列（附 `upload_id` 列）

**理由**（规格倾向 status 列）：
- 独立 `uploads` 表会冗余复制文件名、文件夹、过期时间等元数据，且在 complete 时需要做跨表迁移事务；在 `files` 表加 `status` 列让 pending 记录复用同一张表，complete 时只需一次原子更新（`UPDATE status='active', size_bytes=?, sha256=?, upload_id=NULL`）。
- multipart 上传需要在 init 时记录 S3 返回的 `uploadId`，供后续分片签名、完成和中止使用，因此除 `status` 外同步增加一个可空列 `upload_id TEXT`。

**迁移命名**：增量迁移命名为 `files_uploads_v1`（描述性，且避免与生产数据库账本中已有的历史 `schema_v1` 至 `schema_v6` 发生名称冲突）。

---

## 二、迁移方案（对已坍缩 `schema_v1` 基线的增量迁移）

现状：`getMigrations()`（`worker/src/lib/migrations.ts`）当前已坍缩为单一基线 `schema_v1`，执行器按账本幂等执行；生产库账本中已存在 `schema_v1`，执行器会判定为 skipped。

改动方案：
1. **基线更新**（`worker/src/lib/schema.ts`）：在 `files` 表 DDL 中增加两列：
   ```sql
   status    TEXT NOT NULL DEFAULT 'active',
   upload_id TEXT
   ```
   紧随 `r2_key` 列之后。新安装环境直接由基线建出包含这两列的终态表结构。
2. **增量迁移注册**（`worker/src/lib/migrations.ts`）：新增第二个迁移 `files_uploads_v1`，使用 `prepare` 钩子实现**幂等 ALTER**（针对存量数据库升级），`sql` 留空：
   ```ts
   {
     name: "files_uploads_v1",
     sql: "",
     prepare: async (ctx) => {
       const t = tableName(ctx.prefix, "files")
       const cols = await ctx.db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()
       const has = (n: string) => cols.results.some((c) => c.name === n)
       if (!has("status")) {
         await ctx.db.prepare(`ALTER TABLE ${t} ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`).run()
       }
       if (!has("upload_id")) {
         await ctx.db.prepare(`ALTER TABLE ${t} ADD COLUMN upload_id TEXT`).run()
       }
     }
   }
   ```
   *说明*：SQLite 的 `ALTER TABLE ADD COLUMN` 不具备幂等性，而执行器在失败重试时会重新执行同一迁移；使用 `PRAGMA table_info` 先检查列是否存在可保证绝对幂等，与 `migrations-runner.ts` 中已有的 `hasLedgerShape` 模式一致。
3. **静态 SQL 同步**（`worker/src/db/schema.sql`）：通过运行 `pnpm --filter ./worker schema:sql` 重新生成，确保通过 `worker/test/schema-sql.test.ts` 的一致性断言。
4. **账本测试适配**（`worker/test/migrations-ledger.test.ts`）：更新断言以允许包含空 `sql` 的 prepare-only 增量迁移，并增加存量库升级（加列且保持默认 active）的验证用例。

---

## 三、改动清单（按文件与模块）

### 1. 限额去钳制

- **`worker/src/core/limits.ts`**：
  - 删除 `PLATFORM_HARD_CAP_BYTES`（100 MiB 硬顶常量）。
  - 调整默认限额常量：
    - `DEFAULT_FILE_QUOTA_BYTES = 10 * 1024 ** 3`（10 GiB = 10,737,418,240 字节）。
    - `DEFAULT_FILE_SINGLE_MAX_BYTES = 2 * 1024 ** 3`（2 GiB = 2,147,483,648 字节）。
  - `resolveFileLimits`：移除对平台硬顶的 `Math.min` 钳制，`effectiveSingleMaxBytes` 直接等于解析得到的生效配置（全局配置或单人覆盖）。
- **`worker/src/lib/settings.ts`**：
  - `FileLimitSettings` 类型定义及 `readFileLimitSettings` 返回值删去 `effectiveSingleMaxBytes`、`effectiveSingleMaxMB`、`platformHardCapMB` 三个字段，仅保留 `defaultQuotaBytes/defaultSingleMaxBytes/defaultQuotaMB/defaultSingleMaxMB`（去钳制后 effective ≡ default，冗余；与前端 #15 的 api-types 清理完全一致）。
  - 运行时校验用的 `worker/src/core/limits.ts` 中 `UserLimitsResolution.effectiveSingleMaxBytes` 保留不动，两者不混淆。
- **`worker/src/routes/admin.ts`**：
  - 调整更新限额时的数值校验规则，移除 100 MiB 上限限制，支持管理员配置数 GiB 的单文件限额。

### 2. S3 客户端层（Worker 内部）

- **`worker/src/lib/s3.ts`**（新建）：
  - 引入 `aws4fetch` 的 `AwsClient`。
  - S3 端点推导：`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`，目标桶为 `cbox-files`。
  - 凭据装载：从 `env.R2_ACCESS_KEY_ID` 与 `env.R2_SECRET_ACCESS_KEY` 加载；若缺失则在相关操作时抛出明确的配置错误。
  - 封装核心方法：
    - `presignPut(key, contentLength, contentType, expiresIn = 900)`：生成单个 PUT 预签名 URL。必须配置 `aws: { signQuery: true, allHeaders: true }`，强制将 `content-length` 与 `content-type` 写入 `X-Amz-SignedHeaders`。
    - `createMultipartUpload(key, contentType)`：向 S3 发送 `POST /${bucket}/${key}?uploads`，解析响应 XML 中的 `<UploadId>`。
    - `presignUploadPart(key, uploadId, partNumber, expiresIn = 900)`：生成分片上传预签名 URL（查询参数含 `partNumber` 和 `uploadId`）。
    - `completeMultipartUpload(key, uploadId, parts: { partNumber: number, etag: string }[])`：组装 `<CompleteMultipartUpload>` XML 请求体，向 S3 发送 `POST /${bucket}/${key}?uploadId=${uploadId}` 完成合并。
    - `abortMultipartUpload(key, uploadId)`：向 S3 发送 `DELETE /${bucket}/${key}?uploadId=${uploadId}` 中止分片上传。
  - 测试友好设计：支持注入可选的 `fetch` 替身函数，以便在单元测试和集成测试中完全隔离真实 S3 网络调用。

### 3. 数据层扩展与过滤

- **`worker/src/db/queries/uploads.ts`**（新建）：
  - `insertPendingUpload(db, prefix, data)`：插入一条 `status = 'pending'` 的记录（包含文件 ID、用户 ID、文件夹 ID、文件名、声明大小、R2 对象 key、S3 upload_id、创建时间、过期时间等）。
  - `findPendingUploadById(db, prefix, id, userId)`：根据 ID 和用户 ID 查询对应的 pending 记录。
  - `activateUpload(db, prefix, id, actualSizeBytes, sha256)`：原子更新上传记录，置 `status = 'active'`，更新 `size_bytes = actualSizeBytes`、`sha256 = sha256`，并将 `upload_id` 置为 `NULL`。
  - `deletePendingUpload(db, prefix, id)`：删除 pending 上传记录。
  - `listStalePendingUploads(db, prefix, cutoffEpoch)`：检索创建时间早于 `cutoffEpoch`（如 24 小时前）且仍处于 `pending` 状态的文件列表。
- **`worker/src/db/queries/files.ts`**：
  - `listFiles`：查询条件显式添加 `AND status = 'active'`，保证文件列表和文件夹视图中不出现 pending 文件。
  - `getFileRecord`：下载与读取详情时增加 `AND status = 'active'` 校验。
  - `getUserUsageBytes`：**保持现状统计全部属于该用户的记录**（由于 pending 记录存入的是声明大小，计入用量可防止并发 init 绕过容量配额）。
- **`worker/src/db/queries/shares.ts`**：
  - `createShareRecord` 与 `findActiveShareByToken`：关联查询中增加 `AND status = 'active'` 限制，严禁对 pending 文件创建分享或通过分享下载。

### 4. 上传路由与生命周期

- **`worker/src/routes/files.ts`**：
  - **移除旧路由**：彻底删除旧的 `POST /`（即 `POST /api/files`）中转缓冲上传端点。
  - **端点 1：`POST /uploads/init`**：
    - 入参：`{ filename: string, declaredSizeBytes: number, folderId?: string, expiresIn?: string }`（沿用现行 `expiresIn` preset 字符串，如 `never`/`1h`/`24h`/`7d`/`30d`，走现有 `isValidExpiresInPreset` + `calculateExpiresAt` 计算过期时间）。
    - 鉴权：需要有效用户 Session。
    - 校验限额：解析该用户生效的单文件上限及存储配额。若 `declaredSizeBytes > effectiveSingleMaxBytes` 或 `currentUsage + declaredSizeBytes > quotaBytes`，直接返回 400 拒绝。
    - 生成对象 Key：沿用现行规则 `u${userId}/${fileId}`（`fileId = crypto.randomUUID()`，与数据库记录 ID 同值）。
    - 模式分支：
      - 若 `declaredSizeBytes <= 100 * 1024 * 1024`（100 MiB）：判定为 `single` 模式。调用 `presignPut` 生成单文件预签名 PUT URL（绑定 Content-Length），`upload_id` 置为 `NULL`。
      - 若 `declaredSizeBytes > 100 * 1024 * 1024`：判定为 `multipart` 模式。调用 S3 `createMultipartUpload` 获取 S3 `uploadId`，设置分片大小 `partSize = 10 * 1024 * 1024`（10 MiB）。
    - 数据库落盘：调用 `insertPendingUpload` 写入 `status = 'pending'` 记录（记录声明大小）。
    - 响应结构：`{ uploadId: fileId, mode: "single" | "multipart", partSize: 10485760, url?: string }`。
  - **端点 2：`POST /uploads/:id/part-urls`**：
    - 入参：`{ partNumbers: number[] }`。
    - 校验：限制 `partNumbers` 数组长度在 1 到 50 之间；校验当前记录必须为该用户且处于 `pending` 状态、且存在 `upload_id`。
    - 批量签名：循环调用 `presignUploadPart` 生成各分片的预签名 URL（有效期 15 分钟，支持客户端重复请求以补签过期分片）。
    - 响应结构：`{ parts: [{ partNumber: number, url: string }] }`。
  - **端点 3：`POST /uploads/:id/complete`**：
    - 入参：
      - single 模式：`{ sha256: string }`。
      - multipart 模式：`{ sha256: string, parts: [{ partNumber: number, etag: string }] }`。
    - 处理流程：
      - 校验记录存在性、归属及 pending 状态。
      - 若为 multipart：调用 S3 `completeMultipartUpload` 合并分片。
      - 统一校验实际对象：调用 Worker 的 R2 绑定 `env.FILES.head(r2_key)` 获取实际存储大小。若对象不存在，返回 400。
      - 限额复核：检查实际大小是否超单文件上限，以及 `(currentUsage - declaredSizeBytes + actualSizeBytes) > quotaBytes` 是否超配额。
      - 超限处理：若实际大小违背限额规则，调用 `env.FILES.delete(r2_key)` 物理删除对象，调用 `deletePendingUpload` 废弃记录，返回 400。
      - 校验通过：调用 `activateUpload` 更新为 active，记录实际大小和客户端提交的 sha256，清空 `upload_id`，返回激活后的文件记录。
  - **端点 4：`DELETE /uploads/:id`**：
    - 中止上传：
      - 校验记录存在性及归属。
      - 若包含 `upload_id`，调用 S3 `abortMultipartUpload` 中止 S3 分片。
      - 调用 `env.FILES.delete(r2_key)` 兜底清理可能已存在的对象。
      - 调用 `deletePendingUpload` 物理删除 pending 记录，即时释放预占额度。

### 5. 定时清理任务扩展

- **`worker/src/services/scheduled-task.ts`**：
  - 在 `executeCleanupJob`（`noop-log-tick`）中扩展清理步骤：
    - 计算 24 小时前的时间戳（`cutoff = Date.now() - 24 * 3600 * 1000`）。
    - 调用 `listStalePendingUploads` 获取超过 24 小时仍处于 pending 状态的记录。
    - 遍历超期记录：
      - 若有 `upload_id`，尝试调用 S3 `abortMultipartUpload`。
      - 调用 `env.FILES.delete(r2_key)`。
      - 调用 `deletePendingUpload` 删除记录。
    - 清理任务执行指标 `CleanupJobResult` 中新增 `abortedUploads: number` 字段，准确记录清理的超期上传数量。

### 6. 配置、密钥与 CI/CD 规范

- **`worker/src/types.ts`**：
  - `Env` 接口新增可选凭据字段：
    ```ts
    R2_ACCESS_KEY_ID?: string
    R2_SECRET_ACCESS_KEY?: string
    CLOUDFLARE_ACCOUNT_ID?: string
    ```
- **`worker/.dev.vars.example`**：
  - 增补本地开发环境变量示例：
    ```env
    R2_ACCESS_KEY_ID=
    R2_SECRET_ACCESS_KEY=
    CLOUDFLARE_ACCOUNT_ID=
    ```
- **`scripts/materialize-secrets.mjs`**：
  - `REQUIRED` 数组增加：
    ```js
    ["R2_ACCESS_KEY_ID", "organization secret"],
    ["R2_SECRET_ACCESS_KEY", "organization secret"],
    ```
  - `SECRET_KEYS` 数组增加 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`CLOUDFLARE_ACCOUNT_ID`（后者用于注入 Worker 运行时推导 S3 端点）。
- **`.github/workflows/deploy.yml`**：
  - 在 `materialize-secrets` 步骤中补充对应的环境变量传递：
    ```yaml
    R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    ```
- **`README.md`**：
  - 更新「部署 -> 凭证清单」表格，加入 `R2_ACCESS_KEY_ID` 与 `R2_SECRET_ACCESS_KEY`（标注为组织级 Secret 必填），并注明 `CLOUDFLARE_ACCOUNT_ID` 将同步注入 Worker 以供端点解析。

---

## 四、测试影响与用例规划

### 1. 新增测试套件
- **`worker/test/s3-client.test.ts`**：
  - 覆盖 S3 端点构造（基于 Account ID）。
  - 覆盖预签名 URL 生成与参数校验（`X-Amz-Signature`、`X-Amz-Expires=900`、`X-Amz-Algorithm=AWS4-HMAC-SHA256`）。
  - 覆盖 `allHeaders: true` 下 `content-length` 被包含在 `X-Amz-SignedHeaders` 中的特性断言。
  - 使用桩注入（mock fetch）测试 CreateMultipartUpload、CompleteMultipartUpload 与 AbortMultipartUpload 的请求 URL、XML 生成及返回解析。
- **`worker/test/uploads.test.ts`**：
  - 测试 single 上传完整生命周期（init -> 模拟客户端 PUT -> complete -> 状态验证）。
  - 测试 multipart 上传完整生命周期（init -> 获取 part-urls -> 批量上限 50 校验 -> 模拟分片完成 -> complete -> 状态验证）。
  - 测试限额拦截：init 阶段声明大小超限直接拒绝；complete 阶段实际大小超限删除已存对象并作废记录；pending 额度预占对并发 init 的防御生效。
  - 测试中止与清理：DELETE 接口正确调用 abort 并释放占用额度；超期 24 小时的 pending 记录被定时清理任务正确扫描并回收。
  - 测试隔离性：pending 状态文件绝对不出现在文件列表、文件夹汇总或分享链接中。

### 2. 现有测试套件更新
- **`worker/test/limits.test.ts`**：
  - 移除原 100 MiB 硬顶截断用例，改为断言大限额正常生效；默认值断言同步更新为 2 GiB 与 10 GiB。
- **`worker/test/admin-limits.test.ts`**：
  - 断言更新为新默认值（10240 MiB / 2048 MiB），验证响应中不再包含 `effectiveSingleMaxBytes`、`effectiveSingleMaxMB` 与 `platformHardCapMB`。
- **`worker/test/migrations-ledger.test.ts`**：
  - 更新迁移列表长度预期（增至 2 项）；放行空 SQL 的 prepare-only 迁移；验证增量升级在已有生产数据库账本环境下的幂等性。
- **`worker/test/schema-sql.test.ts`**：
  - 重新生成 schema.sql 后，自动断言其与代码 DDL 严格一致。
- **`worker/test/ci-materialize-secrets.test.ts`**：
  - 在有效环境变量列表及密钥集合中同步加入新 R2 凭据断言。
- **旧上传测试适配**：
  - `worker/test/files-upload-download.test.ts`、`spec-acceptance.test.ts`、`shares.test.ts` 中所有依赖旧 `POST /api/files` 上传的代码，统一改造为调用测试辅助函数（先 init，再直接写入测试环境的 Mock R2 桶，最后调用 complete）。

---

## 五、交付与实施顺序

1. **第一步：依赖与凭据配置**
   - `pnpm --filter ./worker add aws4fetch`。
   - 更新 `worker/.dev.vars.example`、`scripts/materialize-secrets.mjs`、`deploy.yml`、`README.md`。
   - 运行 `pnpm test worker/test/ci-materialize-secrets.test.ts` 验证密钥规范。
2. **第二步：数据库架构与迁移**
   - 更新 `worker/src/lib/schema.ts`（加 `status` 和 `upload_id`）。
   - 在 `worker/src/lib/migrations.ts` 增加 `files_uploads_v1` 增量迁移。
   - 运行 `pnpm --filter ./worker schema:sql` 同步 `worker/src/db/schema.sql`。
   - 更新并运行 `worker/test/migrations-ledger.test.ts` 与 `worker/test/schema-sql.test.ts`。
3. **第三步：限额去钳制**
   - 修改 `worker/src/core/limits.ts`、`worker/src/lib/settings.ts`、`worker/src/routes/admin.ts`。
   - 更新并运行 `worker/test/limits.test.ts` 与 `worker/test/admin-limits.test.ts`。
4. **第四步：S3 客户端与数据查询层**
   - 新建 `worker/src/lib/s3.ts` 及对应单元测试 `worker/test/s3-client.test.ts`。
   - 新建 `worker/src/db/queries/uploads.ts`，更新 `files.ts` 与 `shares.ts` 的查询过滤。
5. **第五步：上传路由重构与旧链路下线**
   - 重构 `worker/src/routes/files.ts`，实现 4 个新上传端点，彻底删除旧 `POST /`。
   - 编写 `worker/test/uploads.test.ts`，适配既有相关测试（使用新直传流程辅助函数）。
6. **第六步：定时清理任务扩展**
   - 扩展 `worker/src/services/scheduled-task.ts` 中 24h pending 上传超期清理逻辑并补充测试。
7. **第七步：全量验证**
   - 运行 `pnpm test`（worker 与 web 全部测试通过）。
   - 运行 `pnpm typecheck` 与 `pnpm lint`。
   - 运行 `pnpm check:deploy` 确保部署 dry-run 完全合规。

---

## 六、前置依赖与协作边界

1. **R2 S3 凭据**：
   - 需要在 Cloudflare 平台生成作用域限制为 `cbox-files` 桶读写权限的 S3 访问密钥（`R2_ACCESS_KEY_ID` 与 `R2_SECRET_ACCESS_KEY`）。
   - 本地开发与 CI 自动化测试均采用 Mock S3 机制或桩注入，不依赖真实凭据，不会阻塞代码编写与测试验证。
2. **跨任务协作（前端 #15）**：
   - 前端任务 #15 负责直传上传组件（upload-dialog）及去除管理页面 100 MiB 提示。
   - 后端接口变更（移除 `effectiveSingleMaxBytes`/`effectiveSingleMaxMB`/`platformHardCapMB`）与前端 #15 的 api-types 清理完全一致，前后端可并行开发。
3. **团队纪律与红线**：
   - 严守红线：不私自开 PR、不私自触发评审、不执行合并与部署操作；交付结果在 review 关口等待指挥官处理。
   - 严禁任何敏感密钥出现在代码、提交记录、日志输出或沟通内容中。
   - 提交信息遵循规范，不附加任何 `Co-Authored-By` 或署名信息。
