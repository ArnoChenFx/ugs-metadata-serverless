/**
 * 容器健康检查脚本。
 *
 * 用法：
 *   deno task healthcheck                 # 检查 http://127.0.0.1:$PORT/health
 *   deno run --allow-net --allow-env tools/healthcheck.ts http://other:8080/health
 *
 * 退出码：健康 0，异常 1（Docker 依赖退出码判断容器状态）。
 * 刻意不用 curl/wget：运行镜像是精简镜像，不一定带这些工具，
 * 而 Deno 本来就一定在。
 */

const port = Deno.env.get("PORT") ?? "8080";
const url = Deno.args[0] ?? `http://127.0.0.1:${port}/health`;

try {
  const response = await fetch(url);
  if (response.ok) {
    console.log(`healthy: ${url}`);
    Deno.exit(0);
  }
  console.error(`unhealthy (HTTP ${response.status}): ${url}`);
  Deno.exit(1);
} catch (error) {
  console.error(
    `unreachable: ${url} — ${error instanceof Error ? error.message : error}`,
  );
  Deno.exit(1);
}
