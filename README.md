# UGS Metadata Server

A modern re-implementation of Epic's [UnrealGameSync](https://docs.unrealengine.com/en-US/unreal-game-sync/) Metadata Server.

The original server is a legacy ASP.NET / IIS / MySQL stack that's painful to set up and maintain. This project replaces it with a **single self-contained service**: one Deno process, one SQLite file, no external database, no IIS, no MySQL, no cloud account.

```
UGS Desktop App
      │  HTTP
      ▼
┌──────────────────────────────┐
│  Deno + Hono                 │   ← 一个进程
│         ↓                    │
│  SQLite  ./data/ugs.db       │   ← 一个文件（WAL 模式下另有 -wal/-shm）
└──────────────────────────────┘
```

**UGS 客户端不需要任何改动** —— 所有端点、查询参数、JSON 形状都与原始 ASP.NET 版本 1:1 兼容。

> 仓库名里的 `serverless` 是历史遗留（项目最初是一个 Supabase Edge Functions 版本），
> 现在它就是一个普通的长驻进程，跑在哪里都行。

## Features

- **Drop-in compatible** — 与原版 MetadataServer 端点一致，UGS 客户端零改动
- **零外部依赖** — 数据库用 Deno 内置的 `node:sqlite`，不需要装原生模块，也不需要数据库服务
- **单文件数据** — 所有数据就是一个 `.db` 文件，拷走即备份，换机器即迁移
- **首次运行零配置** — 自动建目录、自动建表，`deno task start` 即可
- **一键容器部署** — `docker compose up -d`，镜像由 GitHub Actions 自动构建（amd64 + arm64）
- **参数化 SQL** — 所有查询走位置占位符绑定，不存在 SQL 注入面

## Prerequisites

- [Deno](https://deno.com/) 2.x —— 本地运行只需要这一个
- *(可选)* [Docker](https://docs.docker.com/get-docker/) —— 想用容器部署时

## Quick Start

```bash
git clone https://github.com/ArnoChenFx/ugs-metadata-serverless.git
cd ugs-metadata-serverless

# 可选：复制配置模板（不复制也能跑，全部有默认值）
cp .env.example .env

# 启动
deno task start
```

启动后会看到：

```
[db] 已打开数据库：./data/ugs.db
UGS Metadata Server 已启动
  数据库   : ./data/ugs.db
  监听地址 : http://0.0.0.0:8080/
  健康检查 : http://0.0.0.0:8080/health
  UGS 配置 : ApiUrl=http://<本机 IP>:8080
```

验证一下：

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"UGS Metadata Server","database":"./data/ugs.db"}

curl "http://localhost:8080/api/latest?Project=//depot/main"
# {"LastEventId":0,"LastCommentId":0,"LastBuildId":0}
```

### 配置 UGS 客户端

UGS 需要一个 `ApiUrl` 来找到本服务。**它不是 Unreal 引擎配置**，不在 `[/Script/...]` 节里，
而是在下面三处之一（按「就近优先」查找），日常只需要第 1 种。

#### 1. 项目配置文件（推荐，随项目走）

在 Unreal 项目目录下建 `Build/UnrealGameSync.ini`，并**提交到 Perforce**（否则客户端拿不到）：

```ini
[Default]
ApiUrl=http://192.168.1.10:8080
```

查找规则：先找以项目路径命名的节（如 `[//depot/main/MyGame/MyGame.uproject]`），
逐级去掉路径末尾向上回退，最后回落到 `[Default]`。想全项目统一就只写 `[Default]`。

#### 2. 站点部署默认值（全团队默认）

`Deployment.json`，放在 `UnrealGameSync.exe` **同目录**：

```json
{ "ApiUrl": "http://192.168.1.10:8080" }
```

自更新部署下这个目录是 `%LOCALAPPDATA%\UnrealGameSync\Latest\`；
UE4 时代的老版本没有这个文件，是把值直接写在 `DeploymentSettings.cs` 里编译进 exe 的。

#### 3. 引擎目录下的全局配置

`<引擎目录>/Programs/UnrealGameSync/UnrealGameSync.ini`，同样是 `[Default]` 节。

> 当「项目」是 `.uprojectdirs` 而不是 `.uproject` 时，UGS 会改读同目录下的
> `DefaultEngine.ini` —— 但读的仍然是普通节名（项目路径或 `[Default]`），
> **不是** `[/Script/UnrealGameSync.UnrealGameSyncSettings]`（这个类在 UGS 源码里不存在）。

#### 注意事项

- **URL 末尾不要带 `/`**。UGS 是直接拼 `${ApiUrl}/api/latest` 的，多一个斜杠会变成 `//api/latest`。
- 如果 UGS 提示 `Database functionality disabled due to empty ApiUrl.`，
  说明上面三处都没读到值。
- 服务默认监听 `0.0.0.0`，局域网内其他机器可直接访问；只想本机访问就把 `HOST` 改成 `127.0.0.1`。
  部署在别的机器上时，把示例里的 `192.168.1.10` 换成那台机器的内网 IP。
- UGS 客户端的 **Perforce 服务器 / 用户名 / depot 路径**等个人设置存在注册表
  `HKCU\SOFTWARE\Epic Games\UnrealGameSync`，和这里的 `ApiUrl` 不是一回事。

### 配置项

全部通过环境变量或 `.env` 文件设置（见 [`.env.example`](.env.example)），进程环境变量优先：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SQLITE_PATH` | `./data/ugs.db` | 数据库文件路径，父目录会自动创建 |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

### 常用任务

```bash
deno task start        # 启动服务（读取 .env）
deno task dev          # 开发模式（--watch，改代码自动重启）
deno task test         # 运行测试（SQLite 层单测 + API 端到端）
deno task check        # 类型检查
deno task healthcheck  # 调用 /health 检查服务状态
```

## 数据与备份

- 所有数据都在 `SQLITE_PATH` 指向的单个文件里（默认 `./data/ugs.db`）。
- 采用 WAL 模式，因此运行时还会看到 `ugs.db-wal` / `ugs.db-shm`，这是正常现象。
- **热备份**：`sqlite3 data/ugs.db ".backup 'backup.db'"`，或者先停服务再整个拷贝 `data/` 目录。
- **重置数据**：停服务后删掉 `data/` 目录，重启会自动重新建表。
- **迁移机器**：把 `data/` 目录拷过去即可，无需导出导入。

## Docker 部署

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
docker compose down                  # 停止（保留数据）
docker compose down -v               # 停止并删除数据卷（慎用）
docker compose up -d --build         # 强制从源码重新构建镜像
UGS_PORT=9000 docker compose up -d   # 换一个宿主机端口
```

手动构建与运行：

```bash
docker build -t ugs-metadata:local .
docker run -d --name ugs-metadata \
  -p 8080:8080 \
  -v ugs-data:/data \
  -e SQLITE_PATH=/data/ugs.db \
  ugs-metadata:local
```

### 镜像

镜像由 [GitHub Actions](.github/workflows/docker-publish.yml) 在 push / 打 tag 时自动构建，支持 `linux/amd64` 与 `linux/arm64`：

```
ghcr.io/arnochenfx/ugs-metadata-serverless:latest
ghcr.io/arnochenfx/ugs-metadata-serverless:main
ghcr.io/arnochenfx/ugs-metadata-serverless:1.2.3   # 打 v1.2.3 tag 时
```

镜像特性：非 root 用户运行、内置 `/health` 健康检查、依赖已预热（运行期无需外网）。

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
| `GET` | `/health` | 就绪检查（会查一次数据库），Docker healthcheck 依赖它 |

> `LastEventId` / `LastCommentId` / `LastBuildId` 的语义是「最近 100 个 changelist 中最早那一条的 id」，
> 也就是一个能覆盖最近改动量的**增量同步起点**，不是最大 id。

## Project Structure

```
ugs-metadata-serverless/
├── deno.json                          # import map + 任务脚本
├── deno.lock                          # 依赖锁（保证构建可复现，必须提交）
├── Dockerfile                         # 容器镜像（两阶段，非 root）
├── docker-compose.yml                 # 一键部署
├── .dockerignore
├── .env.example                       # 环境变量示例
├── .github/workflows/
│   └── docker-publish.yml             # CI：lint/check/test + 构建多架构镜像并推送 GHCR
├── src/
│   ├── server.ts                      # 入口：加载配置 → 打开数据库 → 监听端口 → 优雅退出
│   ├── app.ts                         # Hono 应用装配（路由 + 健康检查）
│   ├── db.ts                          # 数据库门面：连接生命周期 + 公共 SQL 辅助
│   ├── sqlite.ts                      # SQLite 实现：占位符绑定、参数归一化、事务、语句缓存
│   ├── schema.sql                     # 建表脚本（启动时幂等执行）
│   ├── env.ts                         # 轻量 .env 解析器
│   ├── utils.ts                       # 公共工具与枚举映射
│   └── routes/
│       ├── build.ts                   # /api/build
│       ├── cis.ts                     # /api/cis（legacy）
│       ├── comment.ts                 # /api/comment
│       ├── error.ts                   # /api/error
│       ├── event.ts                   # /api/event
│       ├── issue-builds.ts            # /api/issuebuilds
│       ├── issues.ts                  # /api/issues + 子资源
│       ├── latest.ts                  # /api/latest
│       ├── telemetry.ts               # /api/telemetry
│       └── user.ts                    # /api/user
├── test/
│   ├── env_test.ts                    # .env 解析器单测
│   ├── sqlite_test.ts                 # SQLite 层单测（绑定、归一化、事务、schema）
│   └── api_test.ts                    # API 端到端测试
├── tools/
│   └── healthcheck.ts                 # 容器健康检查脚本
└── docs/                              # 计划与开发日志
```

## Development

```bash
deno lint          # 代码风格检查
deno task check    # 类型检查
deno task test     # 测试（不需要任何外部服务）
deno task dev      # 本地热重载开发
```

### 架构说明

**入口与生命周期.** `server.ts` 负责：加载 `.env` → `initDatabase()` → `createApp()` → `Deno.serve()`，
并注册 `SIGINT`/`SIGTERM` 做优雅退出（停收新请求 → 关闭数据库，顺带完成 WAL checkpoint）。
数据库是显式初始化的，所以「路径写错 / 没权限」在启动阶段就会报错，而不是等第一个请求进来。

**SQL 写法.** 路由层统一用模板字符串写参数化 SQL：

```ts
const rows = await sql`SELECT id FROM badges WHERE id > ${lastId}`;
await sql.begin(async (tx) => {
  await tx`DELETE FROM issue_builds WHERE issue_id = ${issueId}`;
});
```

每个 `${值}` 会被替换成 `?` 位置占位符，参数按顺序绑定 —— 插进来的内容永远只是数据。
参数会做一次归一化，因为 SQLite 的绑定接口只接受 `null`/`number`/`bigint`/`string`/`Uint8Array`：

| JS 值 | 绑定值 |
|---|---|
| `undefined` / `null` | `NULL` |
| `true` / `false` | `1` / `0` |
| `NaN` / `Infinity` | `NULL` |
| `Date` | `YYYY-MM-DD HH:MM:SS`（UTC） |
| 对象 / 数组 | JSON 文本 |

**约定.** 新增表或索引时改 `src/schema.sql`（全部写成 `IF NOT EXISTS`，下次启动自动补齐，
不需要迁移工具）；时间戳统一用 `CURRENT_TIMESTAMP`（存成 `YYYY-MM-DD HH:MM:SS` 文本）；
枚举以字符串入库，映射表在 `src/utils.ts`；JSON 列（如 `badges.metadata`）存 TEXT，
读取时用 `utils.ts` 的 `parseJsonColumn()` 解析成对象。

## Differences from the Original

| | Original (ASP.NET) | This Project |
|---|---|---|
| **Runtime** | .NET Framework 4.6.2 + IIS | Deno + Hono |
| **Database** | MySQL 8.0 | SQLite（单文件） |
| **Hosting** | Windows Server / IIS | 任意机器 / Docker |
| **Auth** | None | None (same as original) |
| **Cost** | Windows Server license + VM | 0 |
| **Setup time** | Hours (IIS, MySQL, .NET, config) | Seconds |
| **Maintenance** | OS patches, IIS config, MySQL backups | 拷贝一个文件 |

## 迁移说明

本项目早期版本是一个 Supabase（PostgreSQL + Edge Functions）实现，现已移除：
数据库换成 SQLite，`cloudflare-proxy` 代理目录也已删除（不再需要自定义域名的中转）。
如果服务器不直接暴露公网，用任意反向代理（nginx / Caddy）指向本服务即可。

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

[MIT](LICENSE)
