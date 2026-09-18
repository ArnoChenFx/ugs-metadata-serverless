/**
 * 服务入口。
 *
 * 启动流程：加载 `.env` → 打开 SQLite → 装配 Hono → 监听端口。
 *
 * ```bash
 * deno task start     # 默认监听 0.0.0.0:8080，数据库 ./data/ugs.db
 * deno task dev       # 带 --watch 的开发模式
 * ```
 *
 * 所有配置都来自环境变量（见 `.env.example`）：
 * `SQLITE_PATH`、`PORT`、`HOST`。
 */

import { loadDotEnv } from "./env.ts";
import { closeDatabase, initDatabase } from "./db.ts";
import { createApp } from "./app.ts";

// 先加载 .env：进程环境变量优先级更高，文件只用于补足未设置的项
loadDotEnv({ verbose: true });

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/** 监听端口，默认 8080。 */
const port = Number(Deno.env.get("PORT") ?? "8080");
/** 监听地址，默认 0.0.0.0（容器内必须如此，否则宿主机访问不到）。 */
const hostname = Deno.env.get("HOST") ?? "0.0.0.0";

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[server] 非法的 PORT 值：${Deno.env.get("PORT")}`);
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 在监听之前打开数据库：目录不存在会自动创建，建表脚本会幂等执行。
// 这样「路径写错 / 没权限」这类问题会在启动阶段立刻暴露，而不是等第一个请求。
const database = initDatabase();

const app = createApp();

console.log("UGS Metadata Server 已启动");
console.log(`  数据库   : ${database.path}`);
console.log(`  监听地址 : http://${hostname}:${port}/`);
console.log(`  健康检查 : http://${hostname}:${port}/health`);
// 提示 UGS 客户端该把 ApiUrl 写到哪里（URL 末尾不带斜杠，详见 README）
console.log(
  `  UGS 配置 : 项目/Build/UnrealGameSync.ini 的 [Default] ApiUrl=http://<本机 IP>:${port}`,
);

const server = Deno.serve({ port, hostname }, app.fetch);

// ---------------------------------------------------------------------------
// 优雅退出
//
// 收到 Ctrl+C / docker stop 时先停止接收新请求，再关闭数据库
// （SQLite 会顺便做一次 WAL checkpoint，确保数据落盘）。
// ---------------------------------------------------------------------------

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] 收到 ${signal}，正在关闭…`);
    void (async () => {
      try {
        await server.shutdown();
        closeDatabase();
      } catch (error) {
        console.error("[server] 关闭过程中出现异常：", error);
      } finally {
        Deno.exit(0);
      }
    })();
  });
}
