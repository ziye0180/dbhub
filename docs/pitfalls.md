# dbhub 二开踩坑记录

> 作者: ziye
> 来源: 从 lyra 事实层 `_shared/projects/dbhub/03-engineering/pitfalls.md` 及运维记录迁移（2026-07-03）。

## P001 — ioredis import 风格混乱（default vs named）

**Trigger**: `import Redis from "ioredis"` 编译失败（"Cannot use namespace 'Redis' as a type" + "expression is not constructable"）。

**根因**: ioredis 的 `built/index.d.ts` 同时 re-export `default` 和 named `Redis`，default import 拿到的是 module namespace，不可构造。

**正确做法**:

```typescript
// 错: 拿 namespace, 不可构造
import Redis from "ioredis";

// 对: 拿 named export
import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";
```

**Lesson**: 任何 dual-export 的库优先用 named import。

## P002 — TOML SourceConfig.database 是 string，ioredis db option 是 number

**Trigger**: `db: s.database ?? 0` 把 string `"0"` 传给 ioredis，redis 警告 "ERR value is not an integer"。

**根因**: `SourceConfig.database` 在 dbhub schema 设计为 string（兼容 sqlite 的 file path），ioredis 的 `RedisOptions.db` 是 number。

**正确做法**: 显式 `Number(s.database)` 转换。DB 0 是默认所以问题隐蔽，跨 db 的 source（db=1 等）才会出错。

## P003 — fs.watch 在 macOS Docker bind-mount 上不可靠（toml hot-reload 失效）

**Trigger**: 改 dbhub.toml 期望 hot-reload，实际不生效。

**根因**: macOS Docker Desktop 用 osxfs/gRPC-FUSE 实现 bind-mount，fs notification 不可靠，container 内收不到 inotify 事件，`touch` 也不一定触发。

**Workaround**: 改 toml 后必须 `docker compose restart dbhub`。

**Lesson**: 任何依赖 fs.watch 的功能在 macOS Docker bind-mount 环境下都要手动验证，不能假设 hot-reload 工作。

## P004 — ConnectorManager.connectWithSources([]) 抛 "No sources provided"

**Trigger**: 纯 Redis source 配置（没有 SQL source）时启动抛错。

**正确做法**: 调用前判断 `if (sqlSources.length > 0)` 再 connect。registerTools 同理（空 SQL source 时 silent return，允许 Redis-only setup）。

## P005 — config hot-reload 路径必须过滤 redis source

**Trigger**: toml 任何变更触发 hot reload 时，`config-watcher` 把含 redis 的全量 sources 传给 SQL ConnectorManager，抛 "programming error" 并 rollback，导致 SQL 全断。

**根因**: `server.ts` 首次启动有正确分流（`sources.filter(s => s.type !== "redis")`），但 hot-reload 路径曾漏了同样的过滤。

**Lesson**: SQL / Redis 双路径分流必须在所有入口（启动 + hot-reload + rollback）保持一致，改一处要 grep 其他调用点。已在 commit 708b909 修复，回归用例见 runbook 的 RG-10。

## P006 — upstream 自带 pre-existing TS errors

**Trigger**: `pnpm exec tsc --noEmit` 一堆 TS error，误以为是自己引入的。

**根因**: dbhub upstream 在 ToolConfig 的 discriminated union narrowing 上有大量 pre-existing TS errors。`pnpm build` 用 tsup 不是 tsc，不影响实际产物。

**验证方法**: `git stash --include-untracked` 后再跑 tsc，如果错误还在就是 upstream 已有。

**Lesson**: 二开 fork 时，build 命令是事实，lint/typecheck 可能 noisy。以 `pnpm build` 通过为准，tsc errors 看变化量。

## P007 — pnpm 在 workspace 根目录 add 包要 -w

**Trigger**: `pnpm add ioredis` 报 `ERR_PNPM_ADDING_TO_ROOT`。

**根因**: dbhub 是 monorepo（workspace 含 frontend），pnpm 默认拒绝在根加包。

**Fix**: `pnpm add -w ioredis`。

## P008 — Redis 任何 O(N) 命令都要在工具层包装

**根因**: Redis 单线程，`KEYS pattern` 是 O(N) 扫全库，大库一次 KEYS 就阻塞业务。

**正确做法**: 用 SCAN cursor 增量遍历 + max_keys 上限（详见 decisions/redis-connector-decisions.md D-003）。FLUSHDB / DEBUG OBJECT 等同理，不能透传。

## P009 — 同名环境变量跨环境不同值（配置漂移）

**Trigger**: 本地 `.env.local` 的 `REDIS_PASSWORD` 与生产 Redis 实际密码不同，直接把本地 env 同步到 prod 导致 NOAUTH / 认证失败。

**Lesson**: env var 跨环境同名不同值是高风险漂移点。同步配置到新环境时，每个凭据都要在目标环境实测（TCP + PING / SELECT 1），不能假设本地值可复用。生产凭据以部署机上现有业务项目的 .env 为准。

## P010 — ACR 镜像必须在 Colima docker driver 构建 amd64

**Trigger**: 从 Apple Silicon Mac 直接 `docker push`，prod 机 `docker pull` 报 "no matching manifest for linux/amd64"。

**正确做法**: 在 `moyun-mini` 使用共享脚本 `~/aizmjx/build-scripts/build-dbhub-image.sh`。脚本通过 Colima 的 `docker` driver 执行 `docker build --platform linux/amd64`，本地 inspect 确认架构后再 `docker push`，最后核验 ACR manifest 中存在 `linux/amd64`。不要改回 docker-container builder 的 `buildx --push`；该 builder 在现役 Colima 环境缺少所需的 amd64 binfmt。

## P011 — Docker 部署必须共享 write-lease 状态目录

**Trigger**: 宿主机执行 `dbhub enable <source>` 显示成功，但 HTTP 服务仍返回 `WRITE_ACCESS_REQUIRED`。

**根因**: CLI 和服务端解析的是不同文件系统；只挂载 `dbhub.toml` 不会自动共享 `.dbhub/write-leases.json`。

**正确做法**: 宿主机统一使用 `/www/dbhub/.dbhub`，服务容器以 `/app/.dbhub:ro` 挂载；宿主机包装器通过独立的 `--network none` 管理容器短暂读写同一目录。不要把 CLI 暴露成 MCP tool 或 HTTP 管理接口，否则持有普通 Bearer 的 AI 可能自行提权。
