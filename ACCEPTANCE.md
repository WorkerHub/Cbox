# Cbox R2 直传上传链路 · 独立验收签收表（§验收①-⑤）

- 验收对象：main @ `4cb67d6`（生产已部署 `v1.0.0-38-4cb67d6`，deploy run 44435645373）
- 验收日期：2026-11-19
- 验收方式：⑤ 完整本地校验链；②③④ 本地全栈（迁移链与生产一致）真实代码路径实测；① 以生产真实数据独立取证
- 纪律口径：不改代码、不以「代码看着对」代替实测、凭据/配置不可及的项如实记录、不放水签收

## 结论摘要

| 项 | 标准 | 结论 |
|---|------|------|
| ① | >100 MiB（约 300 MiB）直传成功、SHA-256 与源文件一致、经分享直链下载后哈希一致 | **有条件通过**（核心完整性主张已在生产独立验证；2 个字面缺口见 §1.4，补测路径明确） |
| ② | 声明大小超限 init 即拒；实际大小超限 complete 拒且对象被删 | **通过** |
| ③ | 上传中途放弃，pending 记录与分片被清理任务扫除（可手动触发 tick 验证） | **通过** |
| ④ | 管理页限额填 >100 MiB 生效且无硬顶提示 | **通过** |
| ⑤ | 全量测试绿、合并前分支 CI 在当前 HEAD 绿 | **通过** |

## 0. 前置核验（两条外部配置均落地，非代码缺陷归因解除）

| 项 | 结果 | 证据摘录 |
|----|------|----------|
| 桶 CORS | ✅ | `OPTIONS https://967399d1b7212c427f5c032b7f7618f2.r2.cloudflarestorage.com/cbox-files/qa-preflight-probe`（Origin: https://cbox.oneboy.app, Access-Control-Request-Method: PUT）→ **204**，`Access-Control-Allow-Origin: https://cbox.oneboy.app`、`Allow-Methods: PUT`、`Allow-Headers: content-length`、`Max-Age: 3600`。ETag 可读性由生产 multipart 完成成功实操证实（浏览器需读到分片 ETag 才能 complete，见 §1.1） |
| 单文件上限 | ✅ | `cbox_system_settings`：`file_quota_default_bytes=209715200`、`file_single_max_default_bytes=209715200`（均 200 MiB，>100 MiB，已生效） |
| 部署版本 | ✅ | 生产版本 `v1.0.0-38-4cb67d6`（= main HEAD）；`cbox_files` 含 `status`、`upload_id` 两列（`files_uploads_v1` 迁移已应用） |
| 清理任务 | ✅ | `cbox_auth_counters` 存在 `scheduled_tick:noop-log-tick:` 计数（window_start=2026-11-19T00:00:04Z），tick 有运行记录 |

## 1. ① 直传 >100 MiB + SHA-256 + 分享直链哈希 —— 有条件通过

### 1.1 已执行并验证

**(a) 生产 multipart 直传成功（>100 MiB）**

用户在生产环境（https://cbox.oneboy.app）实测：进度条正常、116 MB 上传成功。D1 取证：

```
cbox_files 行：id=3320dc12-86d5-4aa2-94e8-e1f7c98e96a1
name=大黄蜂播放器2606更新windows+mac电脑都有.zip
size_bytes=121966368（116.4 MiB > 100 MiB 阈值 104857600 → multipart 模式，12 分片）
sha256=b88c6f7aa6eec90e6fc943ea73cdd46961f1e747b494258a074561317ef43381
status=active  r2_key=u1/3320dc12-86d5-4aa2-94e8-e1f7c98e96a1
created_at=2026-11-19T01:39:54.281Z
```

该行为 `active` 且带 sha256，意味着 init → 预签名分片 PUT → complete（含 ETag）→ 原子转 active 全链在生产走通。

**(b) 上传→R2 装配字节完整性（独立验证，关键证据）**

不依赖用户报告，直接从生产 R2 下载对象核哈希：

```bash
npx wrangler r2 object get "cbox-files/u1/3320dc12-86d5-4aa2-94e8-e1f7c98e96a1" --remote --file /tmp/obj
# Downloading ... Download complete.
ls -l /tmp/obj   # 121966368 字节 = D1 size_bytes ✓
shasum -a 256 /tmp/obj
# b88c6f7aa6eec90e6fc943ea73cdd46961f1e747b494258a074561317ef43381
```

与 D1 存储的浏览器端哈希**逐字符一致**。该哈希是浏览器对源文件增量计算所得，因此本比对证明：R2 中 multipart 装配后的对象与源文件字节完全一致。

**(c) 分享直链下载路径（本地全栈 e2e，同一构建）**

```
init(声明 20 MiB) → 放置对象 → complete {sha256=cd52d81e25f372e6fa4db2c0dfceb59862c1969cab17096da352b34950c973cc} → 200
POST /api/files/d97cd2a4-62fc-4b52-ab68-8d2a44f27c15/shares {expiresIn:"24h"} → 201
GET /s/407e145e12a17328debbb94ee85d9df759cf9a211fc757c674ad1684e8603ad4  （免登录）
→ 200 OK; Content-Length: 20971520; Content-Disposition: attachment; filename="share-e2e.bin"; X-Content-Type-Options: nosniff
下载文件 shasum -a 256 = cd52d81e25f372e6fa4db2c0dfceb59862c1969cab17096da352b34950c973cc  == 上传时源文件哈希 ✓
```

`/s/:token` 直链代码路径（`worker/src/routes/shares.ts` handlePublicShareDownload）下载字节无损。

### 1.2 未执行（字面缺口）

1. **~300 MiB 规模**：生产上限 200 MiB，300 MiB 声明会被 init 413（限额正确行为）。规模差异仅是分片数量（30 片 vs 已实测的 12 片，同一代码路径；`part-urls` 单批上限 50 片，30 片单批即可）。
2. **生产分享直链腿**：生产 `cbox_shares` 为空（无人建过分享），建分享需登录会话，QA 无生产凭据，无法自行构造。

### 1.3 判定依据说明

「SHA-256 与源文件一致」的链路等价性：浏览器在上传时对源文件流式计算的 SHA-256 存入 D1（`b88c…3381`）；QA 独立从 R2 下载装配后的对象并重算哈希，两者一致 ⇒ R2 对象 == 源文件字节。该验证对象大于旧平台硬顶（100 MiB），且走 multipart 装配路径——即规格要防的核心风险（中转改直传后大文件装配出错）已被生产数据覆盖。

### 1.4 补测路径（任一即可闭环）

- **最小**：用户在管理页对现有 116 MB 文件点一次「分享」，把 `/s/<token>` 链接发给 QA——免登录下载核哈希，① 的分享直链腿在生产闭环。
- **完整**：先把上限调到 ≥300 MiB（如 512 MiB），再传一个 ~300 MiB 文件并分享，QA 用同一方法独立取证。

## 2. ② 声明超限 init 即拒；实际超限 complete 拒且对象被删 —— 通过

**环境**：本地全栈（迁移链 schema_v1 + files_uploads_v1 与生产一致；管理员限额经 `PUT /api/admin/settings` 设为 300 MB / 500 MB，`/api/me/usage` 回读 `singleMaxBytes=314572800` 生效）。

**(a) 声明超限 → init 即拒（413）**

```bash
POST /api/files/uploads/init {"filename":"over-limit.bin","declaredSizeBytes":314572801}
→ HTTP 413 {"error":"File size exceeds the maximum allowed limit of 314572800 bytes",
            "code":"FILE_TOO_LARGE","limitBytes":314572800}
```

边界对照：声明 314572800（=上限）→ 未被 413（限额校验放行，随后进入 multipart initiate 因本地假凭据网络失败 500，见观察项 1）——证明限额校验恰好在上限值放行、无 100 MiB 钳制。

**(b) 实际超限 → complete 拒且对象被删**

```bash
# 1) init 声明 50 MiB（单文件模式）→ 201, uploadId=8cd07969-a438-40f7-a6b1-135900cd9757
# 2) 附带核验：不放对象直接 complete → 400 OBJECT_NOT_FOUND（head 校验生效，行未消费）
# 3) 本地桶放置 330 MiB 对象（346030080 > 314572800）于 r2_key
# 4) complete：
POST /api/files/uploads/8cd07969-…/complete {"sha256":"bb…"}
→ HTTP 413 {"error":"File exceeds single file size limit","code":"FILE_TOO_LARGE","limitBytes":314572800}
# 5) 复核：
#    R2 对象 → "The specified key does not exist"（已删）
#    D1 pending 行 → []（已删）
#    重放 complete → 404 UPLOAD_NOT_FOUND
```

代码语义（`worker/src/routes/files.ts` complete handler）：`FILES.head(r2_key).size > effectiveSingleMaxBytes` → `FILES.delete(r2_key)` + `deletePendingUpload` + 413 FILE_TOO_LARGE；配额超限同构（413 QUOTA_EXCEEDED 同样删对象删行）。**说明**：对象放置为状态构造（本地无真实 R2 S3 凭据），但「复核→拒→双删」是真实代码路径执行；multipart complete 的复核走同一 head→size 检查（单元测试覆盖）。

## 3. ③ 中途放弃 → 手动触发 tick 扫除 —— 通过

**状态构造**（本地全栈）：

| 行 | 形态 | created_at | 对象 |
|----|------|-----------|------|
| A `d8243d75…` | 单文件 pending（20 MiB） | 改为 2026-11-17T20:00Z（~30h 前，stale） | 已放置 |
| C `cccccccc-1111-…` | multipart pending（`upload_id=qa-simulated-mpu-uploadId-777`，手插行模拟放弃的分片上传） | 2026-11-17T21:00Z（stale） | 已放置 |
| B `fb390fe6…` | 单文件 pending（30 MiB，**新鲜对照**） | 当天（未动） | 已放置 |

**触发与结果**：

```
POST /api/admin/cleanup   （管理面手动触发，直调 executeCleanupJob，trigger=admin）
→ HTTP 200 {"success":true,"deletedFiles":0,"deletedShares":0,"deletedOrphans":0,"abortedUploads":2}

日志：
WARNING Cleanup: failed to abort multipart upload: Error: internal error; …   ← 本地假凭据，abort 失败仅告警
Cleanup completed (trigger=admin): 0 files, 0 shares, 0 orphans, 2 aborted uploads deleted

复核：
A 行删 ✓  A 对象删 ✓
C 行删 ✓  C 对象删 ✓   ← abort 失败未阻断清扫（best-effort 设计实测成立）
B 行保留 ✓  B 对象保留 ✓ ← 24h 阈值判定正确，非无差别全清
```

stale 判定：`status='pending' AND created_at < now-24h`（`worker/src/db/queries/uploads.ts` listStalePendingUploads；`ORPHAN_AGE_THRESHOLD_SECONDS=24h`）。清扫顺序（`worker/src/services/scheduled-task.ts` step 4）：有 upload_id 且 S3 已配置 → abort（失败 warn 不阻断）→ `FILES.delete(r2_key)`（best-effort）→ 无条件 `deletePendingUpload` → 计数。**生产侧**：tick 有运行计数、生产 `cbox_files` 无 pending 残留（健康态，无可清扫样本属正常）。

## 4. ④ 管理页限额 >100 MiB 生效且无硬顶提示 —— 通过

**服务端**：

```
PUT /api/admin/settings {"fileLimits":{"defaultQuotaMB":500,"defaultSingleMaxMB":300}} → 200
GET /api/admin/settings → fileLimits.defaultSingleMaxBytes=314572800（保存成功，无钳制拒绝）
GET /api/me/usage → {"usedBytes":0,"quotaBytes":524288000,"singleMaxBytes":314572800}（生效值回读）
边界：声明 314572801 → 413；声明 314572800 → 放行（进入 S3 步骤才失败）——限额恰好等于配置值，无 100 MiB 硬顶
代码口径：worker/src/core/limits.ts MAX_LIMIT_MB=1048576（1 TiB），无钳制
```

**UI 侧**：

- `web/src/pages/admin/file-limits-section.tsx`：输入框 `max=1048576`（1 TiB），无 100 MiB 上限提示
- 文案（zh/en）：仅「必须为 1 到 1048576 之间的正整数」，无「平台硬顶」类提示；grep 全量文案零残留
- 组件测试（admin.test.tsx，随 ⑤ 全量通过）：「验证回显值 500 MB，不再受平台硬顶钳制」+ `expect(screen.queryByText(/受平台硬顶/)).not.toBeInTheDocument()`

**生产旁证**：生产上限 200 MiB（>100 MiB）已保存且生效（用户 116 MB 上传在该限额下通过）。

## 5. ⑤ 全量测试绿 + CI 绿 —— 通过

**本地完整校验链**（main @ 4cb67d6，干净可写工作区）：

```
pnpm install --frozen-lockfile   ✓（lockfile 供给链校验 397 项通过）
pnpm test     → worker: Test Files 36 passed / Tests 250 passed (2.84s)
                web:    Test Files 22 passed / Tests 173 passed (7.44s)
pnpm typecheck → tsc --noEmit（worker+web）✓
pnpm lint     → biome lint . 228 files, no issues ✓
pnpm format:check → biome format . 227 files, no issues ✓
node scripts/check-identity.mjs → 通过：项目名 "Cbox"，仓库/Worker 名 "cbox"，白名单外零残留 ✓
pnpm build    → web 构建成功 + worker tsc --noEmit ✓
pnpm check:deploy → dry-run 通过（DB=D1, FILES=R2 cbox-files, ASSETS）✓
```

**CI**（合并前分支与当前 HEAD）：

| Run | 对象 | 结果 |
|-----|------|------|
| 44414981334 | PR #23（feat(web) 分支）Validate | success |
| 44418855003 | PR #24（feat(files) 分支）Validate | success |
| 44422212485 | main @ 4cb67d6 push | success |
| 44435645373 | deploy workflow_dispatch | success（生产版本 v1.0.0-38-4cb67d6） |

（开着的 renovate PR #19 CI 失败为 vitest 升级单，与本验收链无关。）

## 6. 观察项（低危，不阻塞签收，供实现者参考）

1. **multipart init 的 S3 initiate 失败无结构化错误**
   位置：`worker/src/routes/files.ts:120`（`const s3UploadId = await initiateMultipartUpload(c.env, r2Key, contentType)`，未包 try/catch；对比 multipart complete 路径有 catch → 500 COMPLETE_FAILED）。
   复现：本地假凭据下声明 >100 MiB 的 init → 500 `{"error":"Internal server error"}`（无错误码）。
   期望/实际：期望结构化错误码（如 INITIATE_FAILED）；实际裸 500。
   影响范围：仅 R2 initiate 瞬时故障时的错误呈现，功能与数据不受损；本地测试中该 500 反向证明了限额校验已在更早步骤放行（④ 边界证据）。

2. **慢网络 × 超大文件：分片 URL 一次性预取 + 900s 时效**
   位置：`web/src/lib/api.ts:612-617`（全部 partNumberBatches 先取完存 partUrlMap 再开始上传）；`api.ts:474` `uploadPartWithRetry` 对同一 URL 重试 3 次（间隔 1s），403（签名过期）时不重新获取 URL；预签名时效 `PRESIGNED_URL_EXPIRES_SECONDS=900`。
   影响：整次 multipart 上传耗时 >15 分钟时，靠后分片 403 且重试无效 → 上传失败需重来。300 MiB（30 片 × 10 MiB）在 ≥~350KB/s 网速内可完成，日常可用；更大文件或更慢网络是真实限制。
   缓解方向（简单）：uploadPartWithRetry 对 403 重新调用 part-urls 刷新该批 URL。

## 7. 方法与诚实声明

- ②③④ 的全部判定逻辑在本地全栈真实执行（`wrangler dev` 本地实例、迁移链与生产一致、真实 Worker 代码路径），其中「对象放置」「multipart pending 行」为状态构造——本地无真实 R2 S3 凭据，multipart 的 Worker 侧 S3 调用必然失败，该失败恰好真实测到了 abort best-effort 与 init 无 catch 两条错误路径。
- ① 的核心完整性主张基于**生产**真实数据独立取证：QA 以 wrangler OAuth 的 R2 读权限直接下载生产对象并重算哈希（这是本回合唯一能越过「无生产登录会话」限制的独立取证通道），未采信「代码看着对」，也未采信未经验证的用户陈述（用户的 116 MB 成功仅作为「上传成功」的行为佐证，哈希一致性由 QA 独立重算）。
- 未放水项：① 的 ~300 MiB 规模与生产分享直链腿如实记为字面缺口，补测路径见 §1.4；未以「同一代码路径」为由将其擅自降级为通过。
- 本文件为只读交付物（QA 不改代码）；除本文件外本分支无其他改动。
