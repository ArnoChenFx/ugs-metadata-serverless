# UGS Metadata Server — Serverless Edition

A modern re-implementation of Epic's [UnrealGameSync](https://docs.unrealengine.com/en-US/unreal-game-sync/) Metadata Server.

The original server is a legacy ASP.NET / IIS / MySQL stack that's painful to set up and maintain. This project replaces it with a single TypeScript codebase (Hono) that runs in **two interchangeable modes**:

| 模式 | 数据库 | 运行方式 | 适合场景 |
|---|---|---|---|
| **纯本地（SQLite）** | 单个 `.db` 文件，零外部依赖 | `deno task start` / Docker | 本地联调、单机自建、离线演示、小团队内网 |
| **Serverless（PostgreSQL）** | Supabase Postgres | Supabase Edge Functions | 免运维、自动伸缩、跨地域访问 |

两种模式共用同一份业务代码与同一套 API —— **UGS 客户端不需要任何改动**。

## How It Works

```
                                    ┌──────────────────────────┐
UGS Desktop App                     │  纯本地模式（默认）        │
      │                             │  Deno + Hono             │
      │                             │        ↓                 │
      ▼                             │  SQLite  ./data/ugs.db   │
┌─────────────────────┐             └──────────────────────────┘
│  Cloudflare Worker   │  ← 可选代理（沿用旧的域名）
│  (ugs.yourteam.com) │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│  Supabase Edge Fn   │ → │  Supabase Postgres   │   │  Docker 容器         │
│  (ugs-metadata)     │   │  builds/reviews/...  │   │  SQLite 数据卷       │
└─────────────────────┘   └─────────────────────┘   └─────────────────────┘
        Serverless 模式                                  纯本地模式
```

## Features

- **Drop-in compatible** with the original ASP.NET MetadataServer — all endpoints, query parameters, and JSON shapes are preserved
- **纯本地 SQLite 模式** — 无需任何外部服务，一条命令跑起来，数据就是一个文件，拷走即备份
- **双驱动可切换** — 同一个代码库、同一套 API，靠 `DB_DRIVER` 环境变量在 SQLite / PostgreSQL 之间切换
- **一键部署** — `docker compose up -d`，镜像由 GitHub Actions 自动构建并发布（多架构）
- **零第三方数据库依赖** — SQLite 用的是运行时内置实现（`node:sqlite`），不需要装原生模块
- **Serverless 可选** — 仍然可以 `supabase functions deploy` 部署到边缘节点

## Prerequisites

- **本地模式**：[Deno](https://deno.com/) 2.x（仅此一项，无需 Node、无需数据库）
- **Serverless 模式**：[Node.js](https://nodejs.org/) 18+（用于 `npx supabase`）+ 一个 [Supabase](https://supabase.com/) 账号
- **Docker 模式**：[Docker](https://docs.docker.com/get-docker/) 或 Docker Desktop
- *(可选)* [Cloudflare](https://cloudflare.com/) 账号，用于自定义域名

---

## 快速开始：纯本地模式（SQLite）

这是最简单的方式，不需要任何外部服务。

```bash
git clone https://github.com/ArnoChenFx/ugs-metadata-serverless.git
cd ugs-metadata-serverless

# 可选：复制环境变量模板（不复制也能跑，默认就是 SQLite）
cp .env.example .env

# 启动（首次运行会自动创建 ./data/ugs.db 并建表）
deno task start
```

启动后会看到：

```
[db] 驱动就绪：sqlite (sqlite:./data/ugs.db)
UGS Metadata Server 已启动
  驱动     : sqlite (sqlite:./data/ugs.db)
  监听地址 : http://0.0.0.0:8080/
  健康检查 : http://0.0.0.0:8080/health
  UGS 配置 : ApiUrl=http://<本机 IP>:8080
```

验证一下：

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"UGS Metadata Server","driver":"sqlite","target":"sqlite:./data/ugs.db"}

curl "http://localhost:8080/api/latest?Project=//depot/main"
# {"LastEventId":0,"LastCommentId":0,"LastBuildId":0}
```

### 配置 UGS 客户端

把 API 地址指向本地服务即可（**注意：本地模式没有 `/ugs-metadata` 前缀**）：

```ini
[/Script/UnrealGameSync.UnrealGameSyncSettings]
ApiUrl=http://192.168.1.10:8080
```

> 如果 UGS 客户端和服务器不在同一台机器上，请把 `localhost` 换成服务器的内网 IP
> （服务默认监听 `0.0.0.0`，局域网可直接访问；只想本机访问就把 `HOST` 改成 `127.0.0.1`）。

### 数据与备份

- 所有数据都在 `SQLITE_PATH` 指向的单个文件里（默认 `./data/ugs.db`）。
- 采用了 WAL 模式，因此运行时还会看到 `ugs.db-wal` / `ugs.db-shm`，这是正常现象。
- **热备份**：用 `sqlite3 data/ugs.db ".backup 'backup.db'"` 或先停服务再直接拷贝整个 `data/` 目录。
- 想换位置 / 重置数据：改 `SQLITE_PATH`，或直接删掉 `data/` 目录重启（会自动重新建表）。

### 常用任务

```bash
deno task start        # 启动服务（读取 .env）
deno task dev          # 开发模式（--watch，改代码自动重启）
deno task test         # 运行测试（SQLite 驱动单测 + API 端到端）
deno task check        # 类型检查
deno task healthcheck  # 调用 /health 检查服务状态
```

---

## 快速开始：Docker 一键部署

```bash
# 1. 取到 compose 文件（或者直接 clone 整个仓库）
curl -kO https://raw.githubusercontent.com/ArnoChenFx/ugs-metadata-serverless/main/docker-compose.yml

# 2. 启动（默认先拉取已发布的镜像；拉不到时用当前目录的源码构建）
docker compose up -d

# 3. 看日志 / 验证
docker compose logs -f
curl http://localhost:8080/health
```

数据保存在名为 `ugs-data` 的具名卷里，容器重建不会丢；`docker compose down` 也不会删除它。

```bash
docker compose down          # 停止（保留数据）
docker compose down -v       # 停止并删除数据卷（慎用）
docker compose up -d --build # 强制从源码重新构建镜像
UGS_PORT=9000 docker compose up -d   # 换一个宿主机端口
```

### 用 PostgreSQL 的 Compose

如果你更希望用 PostgreSQL（多实例共享数据，或者已有现成的 PG 集群）：

```bash
docker compose -f docker-compose.postgres.yml up -d
```

这一份会同时起一个 `postgres:17-alpine` 和一个应用容器，并自动应用 `supabase/migrations/` 里的建表脚本。

### 镜像

镜像由 [GitHub Actions](./.github/workflows/docker-publish.yml) 自动构建，支持 `linux/amd64` 与 `linux/arm64`：

```
ghcr.io/arnochenfx/ugs-metadata-serverless:latest
ghcr.io/arnochenfx/ugs-metadata-serverless:main
ghcr.io/arnochenfx/ugs-metadata-serverless:1.2.3   # 打 v1.2.3 tag 时
```

手动构建与运行：

```bash
docker build -t ugs-metadata:local .
docker run -d --name ugs-metadata \
  -p 8080:8080 \
  -v ugs-data:/data \
  ugs-metadata:local
```

---

## 快速开始：Serverless 模式（Supabase）

### 1. Create a Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New Project**
2. Choose a name, region, and database password
3. Note your **Project Ref** (the ID in the dashboard URL)

### 2. Deploy

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>

# Apply the database schema
npx supabase db push

# Deploy the Edge Function
npx supabase functions deploy ugs-metadata --no-verify-jwt
```

That's it. Your server is live at:

```
https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata
```

### 3. Test It

```bash
curl "https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata/api/latest"
# {"LastEventId":0,"LastCommentId":0,"LastBuildId":0}
```

### 4. Configure UGS

```ini
[/Script/UnrealGameSync.UnrealGameSyncSettings]
ApiUrl=https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata
```

UGS appends `/api/latest`, `/api/build`, etc. automatically.

> **为什么 Supabase 模式 URL 多了 `/ugs-metadata`？**
> Supabase 会把 Edge Function 的名字拼进 URL，而本地模式直接挂在根路径。
> 这个差异由 `BASE_PATH` / `createApp({ basePath })` 处理，两种模式共用同一套路由。

## Custom Domain (Optional)

If you already have a domain like `ugs.yourteam.com` pointing to an old server, you can keep that URL working with a Cloudflare Worker proxy.

### Setup

1. **DNS**: In Cloudflare, add an A record for `ugs` → `192.0.2.1` with **Proxy ON** (orange cloud). The IP is a dummy — the Worker intercepts all traffic.

2. **Configure & Deploy**:
   ```bash
   cd cloudflare-proxy

   # Edit wrangler.toml:
   #   - Set SUPABASE_FUNCTION_URL to your Edge Function URL
   #   - Uncomment and set the routes to your domain

   npx wrangler login
   npx wrangler deploy
   ```

3. Done — `http://ugs.yourteam.com/api/latest` now proxies to Supabase.

> 代理同样可以指向本地 / 自建的 Docker 部署，只要把 `SUPABASE_FUNCTION_URL`
> 改成对应地址（例如 `http://192.168.1.10:8080`）即可。

## 两种模式的差异

API 层面两种模式完全一致，只有以下实现层面的差异：

| 项目 | SQLite 模式 | PostgreSQL 模式 |
|---|---|---|
| `LastEventId` / `LastCommentId` / `LastBuildId` | 相同算法（最近 100 个 changelist 的最早 id） | 同左 |
| `Project` 匹配 | SQLite 的 `LIKE` 对 ASCII 默认大小写不敏感 | Postgres 的 `LIKE` 大小写敏感 |
| JSON 列（`Metadata`） | 以 TEXT 存储，读取时统一解析成对象 | `jsonb`，驱动自动解析成对象 |
| 布尔值 | 以 `0` / `1` 存储 | 原生 `boolean` |
| 时间戳精度 | 毫秒（`strftime`） | 微秒（`now()`） |
| 并发写入 | 单写者模型，靠 `busy_timeout` 排队 | 原生并发 |
| 数据库迁移 | 启动时自动执行幂等的 `schema.sqlite.sql` | `supabase db push` |

> 关于 `Project` 匹配：路由层在 SQL 之后还会用 JS 做一次精确的大小写无关过滤，
> 因此**对外的返回结果是一致的**，差异只体现在 SQL 阶段的候选集大小上。

## API Reference

All endpoints match the original MetadataServer exactly.

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/latest?Project=...` | Get latest event/comment/build IDs for delta sync |
| `GET` | `/api/build?Project=...&LastBuildId=...` | Get builds since a given ID |
| `POST` | `/api/build` | Submit a build result |
| `GET` | `/api/event?Project=...&LastEventId=...` | Get user reviews/votes since a given ID |
| `POST` | `/api/event` | Submit a review (Good, Bad, Investigating, etc.) |
| `GET` | `/api/comment?Project=...&LastCommentId=...` | Get comments since a given ID |
| `POST` | `/api/comment` | Post a comment on a changelist |
| `GET` | `/api/user?Name=...` | Find or create a user |

### Issue Tracking

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/issues` | List issues (filter: `?IncludeResolved`, `?MaxResults`, `?User`) |
| `GET` | `/api/issues/:id` | Get a single issue |
| `POST` | `/api/issues` | Create an issue |
| `PUT` | `/api/issues/:id` | Update an issue |
| `DELETE` | `/api/issues/:id` | Delete an issue |
| `GET/POST` | `/api/issues/:id/builds` | Issue builds |
| `GET/POST` | `/api/issues/:id/diagnostics` | Issue diagnostics |
| `GET/POST/DELETE` | `/api/issues/:id/watchers` | Issue watchers |
| `GET` | `/api/issuebuilds/:id` | Get a specific issue build |
| `PUT` | `/api/issuebuilds/:id` | Update a build outcome |

### Telemetry

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/telemetry?Version=...&IpAddress=...` | Submit timing telemetry |
| `GET` | `/api/error?Records=10` | Get recent errors |
| `POST` | `/api/error?Version=...&IpAddress=...` | Submit error telemetry |

### Legacy

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/cis` | Deprecated — proxies to build/latest (kept for backward compat) |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | 存活检查（不访问数据库） |
| `GET` | `/health` | 就绪检查（会 ping 一次数据库），Docker healthcheck 依赖它 |

## Project Structure

```
ugs-metadata-serverless/
├── deno.json                                # 根配置：import map + 任务脚本
├── deno.lock                                # 依赖锁（保证构建可复现，必须提交）
├── Dockerfile                               # 容器镜像（默认 SQLite 模式）
├── docker-compose.yml                       # 一键部署（SQLite）
├── docker-compose.postgres.yml              # 可选：自建 PostgreSQL
├── .dockerignore
├── .github/
│   └── workflows/
│       └── docker-publish.yml               # CI：测试 + 构建多架构镜像并推送 GHCR
├── tools/
│   └── healthcheck.ts                       # 容器健康检查脚本
├── test/
│   ├── env_test.ts                          # .env 解析器单测
│   ├── db_config_test.ts                    # 驱动选择 / 前缀规范化单测
│   ├── sqlite_driver_test.ts                # SQL 方言、参数归一化、事务单测
│   └── api_sqlite_test.ts                   # 纯本地模式 API 端到端测试
├── supabase/
│   ├── config.toml                          # Supabase 项目配置
│   ├── migrations/
│   │   └── 00001_initial_schema.sql         # PostgreSQL schema
│   └── functions/
│       └── ugs-metadata/
│           ├── deno.json                    # Edge Function 的 import map
│           ├── index.ts                     # Supabase Edge Function 入口（带前缀）
│           ├── serve.ts                     # 本地 / 自建入口（无前缀）
│           ├── app.ts                       # Hono 应用装配（两种入口共用）
│           ├── db.ts                        # 数据库门面：驱动选择 + 公共 SQL 辅助
│           ├── drivers/
│           │   ├── types.ts                 # 统一的 SqlTag / SqlDriver 接口
│           │   ├── postgres.ts              # postgres.js 驱动
│           │   └── sqlite.ts                # node:sqlite 驱动 + SQL 方言翻译
│           ├── env.ts                       # 轻量 .env 解析器
│           ├── schema.sqlite.sql            # SQLite schema（启动时自动应用）
│           ├── utils.ts                     # 公共工具与枚举映射
│           └── routes/                      # 全部 API 路由
│               ├── build.ts                 # /api/build
│               ├── cis.ts                   # /api/cis (legacy)
│               ├── comment.ts               # /api/comment
│               ├── error.ts                 # /api/error
│               ├── event.ts                 # /api/event
│               ├── issue-builds.ts          # /api/issuebuilds
│               ├── issues.ts                # /api/issues + 子资源
│               ├── latest.ts                # /api/latest
│               ├── telemetry.ts             # /api/telemetry
│               └── user.ts                  # /api/user
└── cloudflare-proxy/
    ├── worker.js                            # Cloudflare Worker 代理
    └── wrangler.toml                        # Wrangler 配置
```

## 架构说明

### 驱动抽象

路由层只依赖 `drivers/types.ts` 里的 `SqlTag` 接口：

```ts
const rows = await sql`SELECT id FROM badges WHERE id > ${lastId}`;
await sql.begin(async (tx) => { await tx`DELETE FROM issue_builds WHERE issue_id = ${id}`; });
```

`db.ts` 负责按 `DB_DRIVER` 选择驱动并**懒加载**实现（第一次执行 SQL 时才连接数据库，
因此测试可以先设置环境变量再构造应用）。

SQLite 驱动内部做了一层「Postgres → SQLite」的方言翻译：

| Postgres 写法 | 翻译成 |
|---|---|
| `${值}` | `?` 位置占位符（参数顺序绑定，天然防注入） |
| `NOW() AT TIME ZONE 'utc'` | `strftime('%Y-%m-%d %H:%M:%f','now')` |
| `${x}::jsonb` | `?`（去掉类型转换） |
| `true` / `false` 参数 | `1` / `0` |
| `undefined` 参数 | `NULL` |

> 驱动实现是用「运行时拼接的说明符」动态 import 的，这样 Supabase 的打包器就不会把
> `drivers/sqlite.ts`（依赖 `node:sqlite`，Edge Runtime 不提供）内联进 Edge Function 产物。

### 扩展存储 / 加索引

- 加表或加索引：同时修改 `supabase/migrations/*.sql`（Postgres）与
  `supabase/functions/ugs-metadata/schema.sqlite.sql`（SQLite）。SQLite 那份会在每次
  启动时幂等执行，新表 / 新索引会自动补齐，不需要额外的迁移工具。
- 加接口：在 `routes/` 里新增路由，保持只用 `${值}` 插值；如果用到新的 Postgres 专有语法，
  记得在 `DIALECT_REWRITES` 里加对应的翻译规则与测试。

## Development

```bash
deno lint          # 代码风格检查
deno task check    # 类型检查
deno task test     # 测试（含 SQLite 方言单测与 API 端到端）
deno task dev      # 本地热重载开发
```

测试默认跑在纯本地 SQLite 模式上（用临时数据库文件），不需要任何外部服务。

### Local Development with Supabase

```bash
# Start local Supabase (requires Docker)
npx supabase start

# Apply migrations locally
npx supabase db reset

# Serve the Edge Function locally
npx supabase functions serve ugs-metadata --no-verify-jwt

# The function is now available at:
#   http://localhost:54321/functions/v1/ugs-metadata/api/latest
```

## Differences from the Original

| | Original (ASP.NET) | This Project (SQLite) | This Project (Postgres) |
|---|---|---|---|
| **Runtime** | .NET Framework 4.6.2 + IIS | Deno | Deno (Supabase Edge Functions) |
| **Database** | MySQL 8.0 | SQLite（单文件） | PostgreSQL 17 |
| **Hosting** | Windows Server / IIS | 任意机器 / Docker | Serverless (Supabase + Cloudflare) |
| **Auth** | None | None (same as original) | None (same as original) |
| **Cost** | Windows Server license + VM | 0 | Free tier for small teams |
| **Setup time** | Hours (IIS, MySQL, .NET, config) | Seconds | Minutes |
| **Maintenance** | OS patches, IIS config, MySQL backups | 拷贝一个文件 | Zero |

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

[MIT](LICENSE)
