# dbhub 运维手册（部署 / 验证 / 回滚）

> 作者: ziye
> 来源: 从 lyra 事实层 `_shared/projects/dbhub/05-runtime/` 及 04-quality 回归套件迁移（2026-07-03）。
> 凭据一律不写在本文档；生产密码以部署机上的 .env / api-keys.toml 为准。

## 当前部署拓扑

| 项 | 值 |
|---|---|
| 公网入口 | `https://dbhub.aizmjx.com/mcp`（Bearer 鉴权，POST JSON-RPC） |
| 健康检查 | `https://dbhub.aizmjx.com/healthz`（无需 auth；`/health` 当前会落到 Workbench 页面，不作为健康证据） |
| 网关机 | 141（8.129.135.141），1Panel OpenResty，proxy 到 prod-B 内网 |
| 后端容器 | prod-B（39.108.79.68 / 内网 172.16.253.246）端口 8787，`/www/dbhub/` |
| 镜像 | `registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub`（必须 amd64，见 pitfalls P010） |
| Host 白名单 | 容器启动参数必须包含 `--allowed-hosts dbhub.aizmjx.com`，禁止使用 `*` |
| 生产 source | awakening / cognitive / awaken_pro / fast_test / awaken-redis（local、online_test 不在 prod，见 data-sources.md） |
| 本地 | ziye Mac docker，`localhost:8787`，`docker compose up -d` |
| OpenResty 配置 | `/opt/1panel/www/sites/dbhub.aizmjx.com/proxy/root.conf`，改后 `docker exec <openresty容器> nginx -t` + `kill -HUP <master PID>` reload |
| SSL | `*.aizmjx.com` 通配证书 |

关键 nginx 事实: proxy 段需显式 `proxy_set_header Authorization $http_authorization` 透传 Bearer；MCP 是 streaming，`proxy_buffering off` + 长 `proxy_read_timeout`。DBHub 服务端必须显式允许反向代理传入的公网 Host，否则 `/healthz` 正常但 `/mcp` 会在鉴权前返回 403。

## 构建与发布链路

镜像打包机事实源：`/Users/ziye/project/persona/multi-agents/lyra/employees/_shared/_infra/build-machine/onboarding.md`。脚本 SSOT 位于同目录的 `scripts/build-dbhub-image.sh`，安装到打包机的 `~/aizmjx/build-scripts/build-dbhub-image.sh`。

```bash
# 本地开发机：先确认待打包 commit 已经推到 origin
COMMIT="$(git rev-parse HEAD)"
git fetch origin
git branch -r --contains "$COMMIT"

# Mac mini 打包机：先做运行时检查（不构建、不推送）
ssh -o ClearAllForwardings=yes moyun-mini \
  '~/aizmjx/build-scripts/build-dbhub-image.sh --check'

# 只推不可变 tag，不触碰 latest
TAG="$(date +%Y%m%d)-$(git rev-parse --short=12 HEAD)"
ssh -o ClearAllForwardings=yes moyun-mini \
  "~/aizmjx/build-scripts/build-dbhub-image.sh --ref $COMMIT --tag $TAG"

# 只有明确批准发布 latest 时才执行；该动作仍不部署生产
ssh -o ClearAllForwardings=yes moyun-mini \
  "~/aizmjx/build-scripts/build-dbhub-image.sh --ref $COMMIT --tag $TAG --latest"

# prod-B：独立的生产部署授权动作
ssh root@39.108.79.68
cd /www/dbhub
# docker-compose.yaml 的 command 必须包含：--allowed-hosts dbhub.aizmjx.com
docker tag registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub:latest dbhub:pre-<change>   # 回滚书签
docker pull registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub:latest
docker compose down && docker compose up -d
```

发布纪律: 构建脚本只负责 build + push，不得顺带部署；每次替换镜像前先 `docker tag` 打回滚书签；改 toml / api-keys.toml 前先 `cp` 带日期的 .bak。

## 配置变更

- 改 `dbhub.toml` / `api-keys.toml` 后必须 `docker compose restart dbhub`（hot-reload 不可信，见 pitfalls P003；api-keys 本来就不热载）
- Bearer key 轮换:

```bash
ssh root@39.108.79.68
cd /www/dbhub
docker run --rm --entrypoint node registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub:latest \
  /app/dist/utils/keygen.js <key-name>
# 输出 raw_key（只出现这一次, 存 1Password, 严禁进 git/聊天记录）+ hash（写 api-keys.toml）
docker compose down && docker compose up -d
```

## 临时写权限（生产）

生产 HTTP 服务使用宿主机授权文件，不开放远程管理 API：

| 项 | 值 |
|---|---|
| 宿主机状态目录 | `/www/dbhub/.dbhub`，权限 `0700` |
| 容器读取路径 | `/app/.dbhub:ro` |
| 宿主机 CLI | `/usr/local/bin/dbhub`，源码为 `scripts/dbhub-host-cli.sh` |
| 管理容器边界 | `--network none`、根文件系统只读，只有 `.dbhub` 挂载可写 |

```bash
# ziye 明确授权时，由人在生产宿主机执行
ssh root@39.108.79.68
dbhub status
dbhub enable awakening             # 默认 10 分钟
dbhub enable cognitive             # 仅 awaken_payment DML
dbhub enable awaken_pro            # awaken_pro_prod DML + validated migration
dbhub enable cognitive --ttl 30m   # 可选延长，最长 1 小时
dbhub enable awaken_pro --ttl 30m  # 可选延长，最长 1 小时
dbhub disable awakening
dbhub disable cognitive
dbhub disable awaken_pro
```

`dbhub enable` 的命令格式不区分权限级别；CLI 会把目标 source 配置的 capability 固化进 lease。默认 `dml` 只允许受控 `INSERT/UPDATE/DELETE`；`cognitive` 只服务 `awaken_payment` DML。`awaken_pro` 的 `dml_and_migration` profile 同时允许默认库 `awaken_pro_prod` 的 guarded DML 与同库前向结构迁移。migration 拒绝普通 DML、`USE`、跨库写目标和破坏性 DDL。lease 过期后的写入一律拒绝。AI 收到 `WRITE_ACCESS_REQUIRED` 后只能提示上述命令，不能通过 MCP/Bearer 自行开启权限。

每个生产 SQL source 必须同时配置 `execute_sql` 与 `search_objects`。后者让 AI 通过 `object_type = "schema"` 获取账号实际可见数据库；不要让工具描述指向一个未注册的 `search_objects`。

## 客户端接入

Claude Code `~/.claude.json`（http transport + Bearer）:

```json
{
  "mcpServers": {
    "dbhub": {
      "type": "http",
      "url": "https://dbhub.aizmjx.com/mcp",
      "headers": { "Authorization": "Bearer <raw_key>" }
    }
  }
}
```

Codex: `codex mcp add dbhub --url https://dbhub.aizmjx.com/mcp --bearer-token-env-var DBHUB_API_KEY`。

切回本地 Mac dbhub: 把 server 配置改回 `docker exec -i dbhub node /app/dist/index.js --transport stdio --config /app/dbhub.toml`。远程与本地两套不要同时 enable 同名 server（race + token 浪费）。改完必须重启 client（MCP 工具列表有 cache）。

## 日常排障

```bash
# 日志
ssh root@39.108.79.68 'docker logs --tail 100 dbhub'
# Auth 状态（期望: loaded N key(s) ... requires Bearer header）
ssh root@39.108.79.68 'docker logs dbhub 2>&1 | grep -i auth'

# 公网验收四连
curl -s https://dbhub.aizmjx.com/healthz                         # 200 + OK
curl -s -X POST https://dbhub.aizmjx.com/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'            # 无 Bearer -> 401
# 错 Bearer -> 401/403; 对 Bearer -> tools 列表, 且 annotations 不含 taskSupport=forbidden
```

本地验证（tools/list + unlock 检查）:

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools[0].annotations.execution'
# 期望: null
```

## Redis 改动永久回归套件

后续每轮 redis 相关改动都要跑（来源: 2026-05-09 首轮全面 QA）:

| ID | 测试 case | 期望 |
|---|---|---|
| RG-01 | 全部 redis_* tool happy path | 全过 |
| RG-02 | WRONGTYPE（redis_get on hash key） | isError + WRONGTYPE 友好返回 |
| RG-03 | 不存在 key | string null / list 空 / hash {} |
| RG-04 | TTL -1 / -2 / 正数 | 三种语义正确 |
| RG-05 | schema 校验（空 keys / 超限 / 负数 limit） | 32602 input validation error |
| RG-06 | mget 1000 keys 边界 | 1000 个 KV 返回 |
| RG-07 | redis_keys SCAN truncated 边界（>max_keys） | count=max_keys, truncated=true |
| RG-08 | 1MB value | 完整返回（注意: 尚无 max_value_bytes 保护, 大 value 会撑爆 LLM context） |
| RG-09 | 断连重连: docker stop/start redis 后 5s 内自动恢复 | 恢复（历史 bug: retryStrategy 永不重试 + isConnected flag 不重置, 708b909 修复） |
| RG-10 | hot reload 不破坏 SQL: touch toml 后 SQL 仍可用 | log 无 rolling back（见 pitfalls P005） |
| RG-11 | tools/list 0 写命令 | grep set/del/flush/expire/hset/lpush/sadd/zadd 全 0 |
| RG-12 | SQL READ-ONLY 拦 INSERT/DELETE | isError + READONLY_VIOLATION |
| RG-13 | 50 并发 redis_get | 50/50 pass |

已知设计债（未修，改到相关代码时顺带评估）:
- 无 `max_value_bytes` 保护，超大 value 完整返回（RG-08）
- `redis_keys` schema 的 limit 上限与实际 `min(limit, max_keys)` 不一致，调用方传大 limit 会困惑

## 回滚 SOP

```bash
# 镜像层回滚
ssh root@39.108.79.68 '
  cd /www/dbhub
  docker tag dbhub:pre-<change> registry.cn-hangzhou.aliyuncs.com/aiawaken/awaken-dbhub:latest
  docker compose down && docker compose up -d
'
# nginx 层回滚
ssh root@8.129.135.141 '
  cp /opt/1panel/www/sites/dbhub.aizmjx.com/proxy/root.conf.bak-<date> \
     /opt/1panel/www/sites/dbhub.aizmjx.com/proxy/root.conf
  docker exec <openresty容器> nginx -t && kill -HUP <master PID>
'
```

## 安全红线

- 2026-05-09 前 dbhub.aizmjx.com 曾公网无鉴权裸奔 5 周（旧 mall_test 部署），已被 Bearer auth 关闭。教训: 任何 dbhub 实例暴露公网前必须先有鉴权，没鉴权只准本地/内网
- raw key 只在生成时出现一次，存 1Password，不进任何仓库和 transcript
- 尚无审计日志（谁查了什么），扩大用户面前必须补
