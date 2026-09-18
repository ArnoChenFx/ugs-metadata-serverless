# 计划：移除 Supabase / Cloudflare，收敛为纯本地 SQLite 单模式

日期：2026-09-18
状态：已完成
分支：`sqlite`
前置计划：[2026-09-18-纯本地SQLite双模式改造.md](./2026-09-18-纯本地SQLite双模式改造.md)

## 背景

上一步把项目改成了 SQLite / PostgreSQL 双驱动（保留 Supabase 部署能力）。
实际使用后确认：**Supabase 与 Cloudflare 这条路不会被用到**，
留着它们只会持续产生成本：

- 多一层驱动抽象（`SqlTag` 接口 + 两个实现 + 运行时动态 import 规避打包器）；
- 多一层「Postgres → SQLite」方言翻译（`NOW() AT TIME ZONE`、`::jsonb` 的正则改写）；
- 每个路由都要同时考虑两种后端的类型差异（`jsonb` 对象 vs TEXT 字符串）；
- 多一套配置概念（`DB_DRIVER`、`SUPABASE_DB_URL`、`BASE_PATH` 前缀）；
- 多一份要维护的 PostgreSQL 迁移脚本；
- 还要为「Supabase 打包器不要把 `node:sqlite` 内联进 Edge Function 产物」这种
  纯云侧问题保留一段绕行代码。

结论：删掉，让项目回到一个形态。

## 目标

1. 删除 `supabase/`（config、migrations、Edge Function 入口）与 `cloudflare-proxy/`。
2. 删除 PostgreSQL 驱动、驱动抽象层、方言翻译层。
3. 删除只在云模式下才需要的概念：`DB_DRIVER`、`BASE_PATH`、`SUPABASE_DB_URL`/`DATABASE_URL`。
4. 代码结构按最终形态重排，路由 SQL 改为 SQLite 原生写法。
5. 保留并继续维护：Docker 一键部署 + GitHub Actions 自动发布镜像、测试、文档。

## 结构调整

```
（旧）                                        （新）
supabase/functions/ugs-metadata/          →   src/
├── index.ts        (Edge 入口，删除)          ├── server.ts   (原 serve.ts)
├── serve.ts                                ├── app.ts
├── app.ts                                  ├── db.ts
├── db.ts                                   ├── sqlite.ts   (原 drivers/sqlite.ts)
├── drivers/                                ├── schema.sql  (原 schema.sqlite.sql)
│   ├── types.ts    (删除)                   ├── env.ts
│   ├── postgres.ts (删除)                   ├── utils.ts
│   └── sqlite.ts                            └── routes/*
├── schema.sqlite.sql
└── routes/*
supabase/{config.toml,migrations}  (删除)
cloudflare-proxy/                  (删除)
docker-compose.postgres.yml        (删除)
```

## 关键改动

| 改动 | 说明 |
|---|---|
| 目录 | 代码从 `supabase/functions/ugs-metadata/` 移到根目录 `src/` |
| 驱动抽象 | 删除 `SqlExecutor` 之外的 `SqlDriver`/`SqlDriverFactory`；只保留一个实现 |
| 动态 import | 删除「运行时拼接说明符」的加载方式，改为普通静态 import |
| 数据库生命周期 | 从「懒加载单例 + 环境变量选择驱动」改为显式 `initDatabase()` / `closeDatabase()` |
| 方言翻译 | 删除 `DIALECT_REWRITES` / `applyDialect`；路由 SQL 改为 SQLite 原生 |
| SQL 改写 | `NOW() AT TIME ZONE 'utc'` → `CURRENT_TIMESTAMP`；`${x}::jsonb` → `${x}` |
| 时间戳格式 | 从 `strftime('%Y-%m-%d %H:%M:%f','now')`（毫秒）统一为 `CURRENT_TIMESTAMP`（秒） |
| 路由前缀 | 删除 `basePath`（原本只为吞掉 Supabase URL 里的 `/ugs-metadata`） |
| 健康检查 | `/health` 从返回 `driver`/`target` 改为返回 `database`（文件路径） |
| 依赖 | `deno.json` 去掉 `postgres`；`deno.lock` 从 4 个 specifier 降到 2 个 |
| 入口 | `serve.ts` 改名 `server.ts`，并使用静态 import（不再需要控制 import 顺序） |

## 附带修掉的一个真实缺陷

改写过程中测试暴露：`execute()` 是同步函数，SQL 语法错误会**同步抛出**而不是返回 rejected promise，
导致 `assertRejects` 报 “Function throws when expected to reject”。
按接口约定「返回 Promise 的函数不应同步抛错」在实现侧修正：
把同步异常统一转成 `Promise.reject`。

## 验证清单

- [x] `deno lint` 无告警（20 个文件）
- [x] `deno task check` 通过
- [x] `deno task test` 全绿（25 passed / 34 steps）
- [x] `deno task start` 冷启动（无 `.env`、无 `data/`）自动建目录建表，各端点返回正确
- [x] `--cached-only` 离线启动通过（等价于容器内无外网）
- [x] 全局搜索确认无 `NOW()` / `::jsonb` / `postgres` / `BASE_PATH` 残留
- [ ] Docker 镜像实际构建（本机无 Docker，交由 CI 的 build 任务验证）
