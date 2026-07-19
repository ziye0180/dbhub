# dbhub 项目决策日志（PM 视角）

> 作者: ziye
> 来源: 从 lyra 事实层 `_shared/projects/dbhub/06-decisions/project-decisions.md` 迁移（2026-07-03），append-only。

## D-001 — Fork bytebase/dbhub 二开，不直接用 upstream

**Date**: 2026-05-09
**Decided By**: ziye

**Context**:
- bytebase/dbhub 是开源 MCP 数据库网关，ziye 需要二开：解锁 subagent（协议层 unlock）、多租户隔离（未来）、Redis 协议支持
- 直接用 upstream 每次重启就丢二开；走 PR 路线上游 review 慢

**Decision**: Fork 到 `ziye0180/dbhub`，二开 patch 顶在 upstream 之上（rebase 模式），月度/季度 sync upstream。

**Trade-off**:
- (+) 完全自主，上线周期短，不依赖 upstream review
- (-) 月度 sync 要做，不做就脱节
- (-) upstream 大改时可能冲突（dbhub 主体稳定，风险小）

## D-002 — unlockTaskSupport: patch MCP SDK 默认行为，让 subagent 能调 dbhub

**Date**: 2026-05-09
**Decided By**: ziye + Colt

**Context**:
- 实测发现 subagent（Claude Code）看不到 `mcp__dbhub__*` 工具
- 根因: MCP SDK@1.25.1 给每个 tool 的 `annotations.execution.taskSupport` 默认注入 `'forbidden'`

**Decision**: 在 `src/tools/index.ts` 加 `unlockTaskSupport(tool)` helper，抹掉所有注册 tool 的 `execution.taskSupport`。3 个调用点（execute_sql / search_objects / custom-tool）各调一次。

**Alternative Considered**:
- 升级 SDK 到没这个默认的版本 — 不存在（1.25.1 是当时最新）
- 改 SDK 源码 — 维护成本大，不可行
- 给 SDK 提 PR — 慢，且不见得接受（这是他们的安全设计）

**Trade-off**:
- (+) 1 个 helper + 3 行调用，极小改动，副作用 0（只动 execution 字段）
- (-) SDK 升级时要重新检查 annotations 结构是否变

**Side Effect**: server 端 unlock 后，Claude Code 根 session 可能 cache 旧 forbidden 状态，需重启 client 才能看到。HTTP fallback（curl 直调 /mcp）100% 可用作兜底。

## D-003 — Dockerfile pin pnpm@10.28.0，不用 @latest

**Date**: 2026-05-09
**Decided By**: Colt

**Context**: `corepack prepare pnpm@latest` 跑到 pnpm 10.29 时触发 `[ERR_PNPM_IGNORED_BUILDS]`（native dep 的 build script 被默认禁用），docker build 失败。

**Decision**: 改成 `corepack prepare pnpm@10.28.0 --activate`，锁版本。

**Trade-off**:
- (+) build 稳定，不随时间漂移
- (-) 手动跟进 pnpm 大版本（通常半年一次）

## D-004 — dbhub.toml max_rows: 1000 提升到 5000

**Date**: 2026-05-09
**Decided By**: ziye

**Context**: 默认 max_rows = 1000，查 awaken 邀请数据 / 内容数据经常超过 1000 被截断，截断的最后一行还可能不完整。

**Decision**: 全部 SQL source 的 max_rows = 5000。

**Considered Alternatives**:
- 升到 10000+ — 单次 token 成本太高
- 加 pagination — 复杂度高，5000 已够用

**Hot-reload caveat**: macOS docker bind-mount 上 `fs.watch` 不可靠，改 toml 后 watcher 可能不触发 reload。改完必须 `docker compose restart dbhub` 才保证生效。

**Note**: dbhub.toml 不入 git，是本地配置。这条决策对应的实际 toml 改动只在部署机生效，fork 仓不带这个值。

## D-005 — fork 与 upstream 同步策略: GitHub UI Sync + 本地 rebase

**Date**: 2026-05-09
**Decided By**: Colt

**Decision**:
- GitHub UI "Sync fork": 适合 fork 没本地修改时，一键同步
- 本地 rebase: 适合 fork 有本地 commit 时，`git rebase origin/main` 把本地 commit 顶在新 base 上
- 两种结合: UI 点 sync 后本地 rebase 把二开 commit 顶上来，再 push fork

**Trade-off**:
- (+) 操作简单，月度跟得上
- (-) 本地需要 stash 临时改动（CLAUDE.md / pnpm-lock.yaml 在 pnpm install 后会自动改）

## D-006 — API Key 完整多租户: 暂缓，简化版 Bearer 已上线

**Date**: 2026-05-09（评估），后续以简化版落地

**Context**: ziye 提出"一个 API Key 对应一个配置文件"，多用户/团队配置隔离。

**Judgment**: P2 暂缓。当前只有 ziye 一个用户，多租户隔离价值低；一旦多 founder / 团队协作则必须有；实施成本不小（toml loader + middleware + workbench 都要改）。

**当前状态**: 完整多租户（tenants/*.toml + per-key 路由）未实施。已实施简化版：单 api-keys.toml + Bearer 鉴权（commit 708b909），生产入口强制 Bearer。

## D-007 — fork 与 upstream 改为人工 merge

**Date**: 2026-07-13
**Decided By**: ziye

**Supersedes**: D-001 中的 rebase 模式，以及 D-005 的 GitHub UI Sync + 本地 rebase 策略。

**Decision**:
- 每次同步前先锁定 upstream tag/commit，并创建、推送合并前 backup tag。
- 使用 merge 保留 fork 与 upstream 的完整历史，不 rebase、不使用 GitHub UI 自动覆盖。
- 冲突文件按语义人工融合；无文本冲突但双方都修改的文件也必须人工复核。
- 验证通过后再提交并推送到 `ziye0180/dbhub`。

**Reason**: fork 已包含 Redis、Bearer/source 白名单和 subagent task support 等长期定制。人工 merge 能保留两条历史，并把上游安全修复与本地能力逐项核对。

## D-008 — pnpm 版本与 upstream packageManager 对齐

**Date**: 2026-07-13
**Decided By**: ziye

**Supersedes**: D-003 的 pnpm 10.28.0 固定版本。

**Decision**: 本地、CI 与 Dockerfile 统一使用 `pnpm@10.17.1`，以 `package.json#packageManager` 为版本 SSOT。

**Reason**: upstream v0.23.0 已在工作流与 package manifest 中固定 10.17.1。统一版本可以避免 lockfile 由不同 pnpm 版本重复改写，同时仍满足 D-003 禁止使用 `@latest` 的稳定性要求。

## D-009 — Docker 镜像统一交给 Mac mini 打包机

**Date**: 2026-07-13
**Decided By**: ziye

**Decision**:
- DBHub 的 `linux/amd64` 镜像只在 `moyun-mini`（用户 `inkroam`）的 Colima 环境构建，本地开发机不再承担 ACR 打包。
- 构建入口以 Lyra `_infra/build-machine/scripts/build-dbhub-image.sh` 为 SSOT，打包机安装副本位于 `~/aizmjx/build-scripts/build-dbhub-image.sh`。
- 每次构建必须显式指定已被 origin branch/tag 包含的 Git ref 和不可变镜像 tag；只有明确批准时才用 `--latest` 移动生产可变标签。
- 脚本使用 Colima `docker` driver 执行 `docker build --platform linux/amd64`，构建后先验证本地架构，再 push 并验证远端 manifest；脚本不负责生产部署。

**Reason**: 生产节点是 x86_64，而日常开发机和打包机都是 Apple Silicon。把跨架构构建收口到已验证的 Mac mini + Colima + Rosetta 基线，可以避免本机 Docker 差异、错误 buildx builder 和 arm64 镜像污染生产，同时把“构建镜像”和“部署生产”拆成两个独立授权动作。

## D-010 — 生产写权限使用宿主机 lease，不开放远程提权 API

**Date**: 2026-07-13
**Decided By**: ziye

**Decision**:
- 生产 lease 状态只存放在 prod-B 的 `/www/dbhub/.dbhub`；DBHub 服务容器只读挂载到 `/app/.dbhub`。
- `/usr/local/bin/dbhub` 是宿主机管理入口，只允许 `enable`、`disable`、`status`，并通过无网络、只读根文件系统的临时容器写 lease。
- 普通 MCP Bearer 只允许调用数据库工具，不能开启写权限；不增加 HTTP 管理端点，也不把 `enable` 注册成 MCP tool。
- `dbhub enable <source>` 命令保持单一入口；实际 lease capability 由目标 `execute_sql` 的 `temporary_write_mode` 决定。默认 `dml` 只允许单条受控 INSERT/UPDATE/DELETE；显式 `migration` 只允许 MySQL/MariaDB 默认库中的 CREATE TABLE、ALTER TABLE ADD、CREATE INDEX 前向结构迁移。
- migration source 必须配置独立默认库；拒绝 `USE`、跨库 DDL 目标、DROP/TRUNCATE、普通 DML，以及无法静态闭合验证的 prepared statement。授权时 capability 固化进 lease，配置热变更不能扩大已存在 lease。

**Reason**: 本地 CLI 写本地文件无法控制远程 HTTP 容器。共享宿主机状态目录能保持实现简单，同时让“数据库访问”和“授予数据库写权限”处于两个不同的能力边界；AI 即使持有 MCP Bearer，也无法通过 DBHub 自己完成提权。把 capability 放进配置和 lease，可以复用同一条宿主机命令而不把 DDL 权限扩散到普通 source。
