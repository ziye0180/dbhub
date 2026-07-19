# dbhub 数据源拓扑与库表语义

> 作者: ziye
> 来源: 从 lyra 事实层 `_shared/projects/dbhub/01-product/project-dossier.md` 等迁移（2026-07-03）。
> 这些事实从源码推不出来: dbhub.toml 不入 git，source 与业务库的映射只存在于部署机配置里。

## 定位

把开源 bytebase/dbhub 二开为 OPC 工具链的数据库网关 MCP，让所有 AI 员工（Claude Code subagent / Codex）安全查 SQL / Redis，不直连数据库客户端，不暴露密码，不写业务库。是工具不是产品。

## Source 与业务的映射

| Source | 实际数据库 | 业务语义 | 使用频次 |
|---|---|---|---|
| `awakening` | `awaken_social_feed` @ 47.113.127.19（自建 MySQL） | 觉醒学院/觉醒星球: 内容、邀请、用户（`awaken_user`、`awaken_feed_content`、`awaken_category` 等 18 张表） | 高 |
| `cognitive` | 默认 `awaken_payment`；migration 固定目标 `awaken_pro_prod` @ 阿里云 RDS（rm-wz9oiykl2xg37t3pu0o） | 认知图解 DML 仍落支付库；通过同一 `dbhub enable cognitive` lease 执行 Awaken Pro 受控结构迁移 | 高 |
| `fast_test` | `fast_test` @ 外部 MySQL | 生产网关上的外部 MySQL 测试 source | 低 |
| `awaken-redis` | Redis @ 生产内网 172.16.0.145:6379（prod）/ 本地 docker（dev） | awaken 后端 cache + session + queue | 中 |
| `local` | `awaken_social_feed` @ 本地 Docker | 开发/测试。只在本地 Mac 有意义，prod 机上无意义（不部署） | 中 |
| `online_test` | 经 SSH tunnel（117.72.176.28） | 线上测试环境。prod-B 上因无 SSH 私钥未部署 | 低 |

历史 source `mall_test`（8.130.123.8 MySQL）已于 2026-05-09 删除，与 awaken 业务无关。

### awaken-redis 多 db 语义

一个 awaken-redis source 通过 tool 的 `db` 参数可访问全部 db（commit 8fb9af1 起），不需要为每个 db 配单独 source：

| db | 归属 |
|---|---|
| 0 | 默认（toml 配置值） |
| 1 | SSO 会话（key 量最大） |
| 6 / 7 | 业务 cache |
| 8 | think 项目 |

用 `redis_info_keyspace_awaken-redis` 可看全部 db 的 key 分布。

## 只读约束（硬边界）

- 所有 SQL source `readonly = true`；只有 ziye 在 DBHub 宿主机执行 `dbhub enable <source>` 后，目标 source 才在有界 TTL 内获得其配置的 capability（见 `project-decisions.md` D-010）
- 未配置 `temporary_write_mode` 时默认 `dml`：只允许单条 INSERT / UPDATE / DELETE，且 UPDATE / DELETE 必须有顶层 WHERE；DDL 和包含写操作的多语句仍拒绝
- 显式配置 `temporary_write_mode = "migration"` 时只允许 MySQL/MariaDB 默认库中的前向 CREATE TABLE / ALTER TABLE ADD / CREATE INDEX 及闭合的 guarded PREPARE 序列；拒绝普通 DML、`USE`、跨库写目标、DROP/TRUNCATE 和任意动态 SQL
- `cognitive` 使用 `dml_and_migration`：普通 DML 始终落默认库 `awaken_payment`；只有通过 migration grammar 的 SQL 才会在连接级临时切到固定配置 `awaken_pro_prod`，执行后恢复默认库。目标库不能由 MCP 调用方传入
- AI 不能通过 MCP 或 Bearer 自行开启 lease；纯只读多语句保持既有行为
- 每个 SQL source 同时暴露 `execute_sql_<source>` 和 `search_objects_<source>`；AI 用 `search_objects` 的 `object_type = "schema"` 主动发现账号实际可见数据库，不需要先执行 `SHOW DATABASES`
- Redis 侧是白名单只读工具集，写命令在 connector 类上没有 method，无法透传（见 decisions/redis-connector-decisions.md D-002）
- `max_rows = 5000`（决策见 decisions/project-decisions.md D-004）；`max_keys = 1000`
- 生产入口强制 Bearer 鉴权

## 数据流向

```
AI 员工 (subagent / main session)
   |  MCP JSON-RPC
   v
MCP client (Claude Code / Codex)
   |  HTTP POST /mcp (+ Bearer, 走公网时)
   v
dbhub container (本地 localhost:8787 或 dbhub.aizmjx.com)
   |  readonly 校验 + max_rows/max_keys 截断
   v
connector (mysql2 / pg / ioredis)
   |
   v
真实 DB (RDS / 自建 / 本地 docker)
```

## 配置文件事实

| 文件 | 说明 |
|---|---|
| `dbhub.toml` | source 定义。不入 git，本地与各部署机各自维护 |
| `.env.local` / `.env` | 凭据，经 `${ENV_VAR}` 替换进 toml。不入 git |
| `api-keys.toml` | Bearer key 注册表（hash），生产用。不入 git，`chmod 600` |
| `docker-compose.yaml` | 本地私货，不入 git，拉 ACR 镜像 `registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub` |
