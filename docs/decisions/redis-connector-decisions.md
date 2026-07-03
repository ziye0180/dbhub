# dbhub Redis connector 技术决策日志

> 作者: ziye
> 来源: 从 lyra 事实层 `_shared/projects/dbhub/06-decisions/dev-colt-decisions.md` 迁移（2026-07-03），append-only。

## D-001 — Redis 不挤进 SQL Connector 接口，改用并行系统

**Date**: 2026-05-09
**Status**: implemented

**Problem**: 最初提议三层抽象（BaseConnector / SQLConnector / KVConnector），让 Redis implements KVConnector。但侦察发现：

- 现有 `Connector` 接口是 SQL 中心化的 11 方法（getSchemas / getTables / getTableSchema / executeSQL 等）
- 5 个 SQL connector（postgres / mysql / mariadb / sqlite / sqlserver）全部 implements `Connector`
- ConnectorManager 单例围绕 `Connector` 接口设计
- 拆接口的重构成本约 3-5h + Redis 实施 2h，远超预算

**Decision**: 并行系统。
- RedisConnector 不 implement Connector 接口，自己一个 class
- RedisManager 单例，parallel to ConnectorManager
- server.ts 启动时按 `source.type === "redis"` 早期分流，不进 SQL 路径
- tools/index.ts 几乎不动（"0 source 抛错" 改成 "0 source 静默返回"）

**Trade-off**:
- (+) 0 风险破坏现有 5 个 SQL connector，边界清晰
- (-) 没有统一接口，后续加新数据库类型（MongoDB / Cassandra 等）要 case-by-case 决定走哪条路
- (-) 重复一些 lifecycle 代码（lazy connect / disconnect），但很薄

**Future Path**: 三层抽象仍是正确方向，项目稳定后可做正式重构。

## D-002 — redis_* tool READ-ONLY whitelist（13+ 个只读工具）

**Date**: 2026-05-09
**Status**: implemented

**Whitelist 逻辑**:

| 命令 | 暴露 | 理由 |
|---|---|---|
| GET / MGET / KEYS / TYPE / EXISTS / TTL / DBSIZE | 是 | meta + string 读取 |
| HGET / HGETALL | 是 | hash 读 |
| LRANGE | 是 | list 读 |
| SMEMBERS / SISMEMBER | 是 | set 读 |
| ZRANGE | 是 | zset 读（含 WITHSCORES） |
| INFO keyspace 段 | 是（后补 redis_info_keyspace） | 多 db 全景，脱敏段 |
| SET / DEL / FLUSH / EXPIRE / HSET / LPUSH / RPUSH / SADD / ZADD | 否 | 写命令，RedisConnector 上无对应 method |
| EVAL / SCRIPT | 否 | 任意脚本注入风险 |
| CONFIG SET / DEBUG | 否 | 系统级写 |
| SUBSCRIBE / PSUBSCRIBE / MONITOR | 否 | 长连接，不适配 stateless MCP |
| INFO 全量 | 否 | 含敏感信息（password / connected_clients） |

**双重审计面**: tools.ts（register 函数）+ connector.ts（对应 method）。加新工具必须两个文件都加。写命令在 connector 类上没有 method 可调，即使想加 tool 也加不进去。

## D-003 — SCAN 替代 KEYS 命令实现 redis_keys

**Date**: 2026-05-09
**Status**: implemented

**Background**: Redis 的 `KEYS pattern` 在大库（100W+ key）会阻塞单线程（O(N) 扫全库），生产业务库直接 KEYS 等于 DDoS。

**Decision**: `redis_keys_<source>` 内部用 `SCAN cursor` 模式增量遍历（每批 COUNT 100），强制 `max_keys` 上限（默认 1000，toml 可配），返回 `truncated: true` 让调用方知道结果不全。

**Trade-off**:
- (+) 不阻塞 redis 单线程，上限保护不爆 token
- (-) MATCH 是 server-side 过滤，性能略低于直接 KEYS，但安全得多

## D-004 — ioredis@5.x 选型

**Date**: 2026-05-09
**Status**: implemented

**Alternatives**: ioredis vs node-redis（官方 v4）。

**Decision**: ioredis。
- awaken 后端 node 侧全用 ioredis，跟生产协议一致，减少调试 surface
- ioredis cluster / sentinel / pipeline 在生产场景更稳定

**配置选择**:
- `lazyConnect: true` — 启动时不连 redis，避免启动失败
- `maxRetriesPerRequest: 1` — 错误尽快暴露给 MCP 调用方，不掩盖
- `connectTimeout` / `commandTimeout` 5000ms — 比 SQL 默认 30s 短

## D-005 — Redis source 在 toml 用 host/port/password，不用 DSN

**Date**: 2026-05-09
**Status**: implemented

**理由**:
- DSN 在 redis 不标准（redis:// rediss:// redis-sentinel:// 多种形式）
- 配置直观；toml-loader 加了早期 guard：redis source 走 host 校验，不走 SQL 的 DSN 路径

**Schema**:

```toml
[[sources]]
id = "<source-id>"
description = "<human-readable>"
type = "redis"             # 必须
host = "<hostname>"        # 必须
port = 6379                # 可选, 默认 6379
password = "${ENV_VAR}"    # 可选, 推荐 env 替换
database = "0"             # 可选, 默认 0 (TOML string, server.ts 转 number)
max_keys = 1000            # 可选, SCAN 上限
command_timeout = 5        # 可选, 秒
```

**Note**: `database` 字段在 TOML 用字符串（SourceConfig.database 是 string 类型以兼容 sqlite path），server.ts 启动时 `Number(s.database)` 转回 number 给 ioredis 的 `db` option。后续可考虑加专用 `db` 字段。

## D-006 — Redis sources 不显示在启动 banner 主表格

**Date**: 2026-05-09
**Status**: known limitation, accepted

**Background**: 启动 banner 的 `generateStartupTable(sources)` 依赖 ToolRegistry，ToolRegistry 只知道 SQL tools。

**Decision**: 接受该 limitation。Redis sources 显示在 banner 之前的 `Registering N Redis source(s)...` 日志行，不进 ASCII 表格。注册成功的事实通过日志可见，只是 cosmetic 问题。
