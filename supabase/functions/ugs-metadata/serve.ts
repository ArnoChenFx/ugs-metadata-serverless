/**
 * 本地 / 自建服务入口（纯本地 SQLite 模式的主要启动方式）。
 *
 * 与 Supabase Edge Function 入口（`index.ts`）的区别：
 *
 *   | | index.ts（Supabase） | serve.ts（本地/自建） |
 *   |---|---|---|
 *   | 路由前缀 | `/ugs-metadata` | 无（可用 BASE_PATH 覆盖） |
 *   | 配置来源 | Supabase 注入的环境变量 | `.env` 文件 + 进程环境变量 |
 *   | 默认数据库 | PostgreSQL | SQLite 单文件 |
 *
 * 启动方式：
 *
 * ```bash
 * deno task start     # 读取 .env，默认监听 0.0.0.0:8080
 * deno task dev       # 带 --watch 的开发模式
 * ```
 */

import { loadDotEnv } from "./env.ts";

// ---------------------------------------------------------------------------
// 第一步：加载 .env
//
// 必须放在任何数据库模块之前：`db.ts` 会在第一次执行 SQL 时读取环境变量来决定
// 使用哪个驱动，下面的 import 全部写成动态形式就是为了控制这个先后顺序。
// ---------------------------------------------------------------------------
loadDotEnv({ verbose: true });

const { createApp, normalizeBasePath } = await import("./app.ts");
const { describeDriver, closeDriver } = await import("./db.ts");

// ---------------------------------------------------------------------------
// 第二步：解析监听配置
// ---------------------------------------------------------------------------

/** 监听端口，默认 8080。 */
const port = Number(Deno.env.get("PORT") ?? "8080");
/** 监听地址，默认 0.0.0.0（容器内必须如此，否则宿主机访问不到）。 */
const hostname = Deno.env.get("HOST") ?? "0.0.0.0";
/** 路由前缀，本地模式默认留空。 */
const basePath = normalizeBasePath(Deno.env.get("BASE_PATH"));

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[serve] 非法的 PORT 值：${Deno.env.get("PORT")}`);
  Deno.exit(1);
}

const app = createApp({ basePath });

// 提前初始化驱动，让「数据库不可用」这类问题在启动阶段就暴露出来，
// 而不是等到第一个客户端请求进来才报错。
const driver = await describeDriver();

console.log("UGS Metadata Server 已启动");
console.log(`  驱动     : ${driver.driver} (${driver.target})`);
console.log(`  监听地址 : http://${hostname}:${port}${basePath || "/"}`);
console.log(`  健康检查 : http://${hostname}:${port}${basePath}/health`);
console.log(
  `  UGS 配置 : ApiUrl=http://<本机 IP>:${port}${basePath}`,
);

const server = Deno.serve({ port, hostname }, app.fetch);

// ---------------------------------------------------------------------------
// 第三步：优雅退出
//
// 收到 Ctrl+C / docker stop 时先停止接收新请求，再关闭数据库连接
// （SQLite 会顺便做一次 WAL checkpoint，确保数据落盘）。
// ---------------------------------------------------------------------------
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[serve] 收到 ${signal}，正在关闭…`);
    void (async () => {
      try {
        await server.shutdown();
        await closeDriver();
      } catch (error) {
        console.error("[serve] 关闭过程中出现异常：", error);
      } finally {
        Deno.exit(0);
      }
    })();
  });
}
