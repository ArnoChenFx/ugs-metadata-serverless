/**
 * Hono 应用装配。
 *
 * 所有 `/api/*` 路径与原始 ASP.NET MetadataServer 保持 1:1 兼容，
 * UGS 客户端不需要任何改动：把 ApiUrl 指向本服务根地址即可，
 * 例如 `ApiUrl=http://192.168.1.10:8080`。
 */

import { Hono } from "hono";
import { buildRoutes } from "./routes/build.ts";
import { cisRoutes } from "./routes/cis.ts";
import { commentRoutes } from "./routes/comment.ts";
import { eventRoutes } from "./routes/event.ts";
import { errorRoutes } from "./routes/error.ts";
import { issuesRoutes } from "./routes/issues.ts";
import { issueBuildsRoutes } from "./routes/issue-builds.ts";
import { latestRoutes } from "./routes/latest.ts";
import { telemetryRoutes } from "./routes/telemetry.ts";
import { userRoutes } from "./routes/user.ts";
import { getDatabase } from "./db.ts";

/** 创建 UGS Metadata Server 的 Hono 应用。 */
export function createApp(): Hono {
  const app = new Hono();

  // 与 UGS 客户端一致的 API 路径
  app.route("/api/build", buildRoutes);
  app.route("/api/cis", cisRoutes);
  app.route("/api/comment", commentRoutes);
  app.route("/api/event", eventRoutes);
  app.route("/api/error", errorRoutes);
  app.route("/api/issues", issuesRoutes);
  app.route("/api/issuebuilds", issueBuildsRoutes);
  app.route("/api/latest", latestRoutes);
  app.route("/api/telemetry", telemetryRoutes);
  app.route("/api/user", userRoutes);

  // 存活检查：不访问数据库，只回答「进程还在不在」
  app.get("/", (c) => c.json({ status: "ok", service: "UGS Metadata Server" }));

  // 就绪检查：会真正查一次数据库，因此 Docker healthcheck 用它
  app.get("/health", async (c) => {
    try {
      const database = getDatabase();
      await database`SELECT 1`;
      return c.json({
        status: "ok",
        service: "UGS Metadata Server",
        database: database.path,
      });
    } catch (error) {
      return c.json(
        {
          status: "error",
          service: "UGS Metadata Server",
          error: error instanceof Error ? error.message : String(error),
        },
        503,
      );
    }
  });

  return app;
}
