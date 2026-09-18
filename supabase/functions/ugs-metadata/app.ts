/**
 * Hono 应用装配。
 *
 * 抽成独立模块的原因是：同一份 API 需要挂载到两种入口上——
 *
 *   - Supabase Edge Function（`index.ts`）：带 `/ugs-metadata` 前缀，
 *     因为 Supabase 会把函数名拼进 URL。
 *   - 本地 / 自建服务（`serve.ts`）：不带前缀，
 *     `http://localhost:8080/api/latest` 直接可用。
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
import { getDriver } from "./db.ts";

/** 应用装配选项。 */
export interface AppOptions {
  /**
   * 路由前缀。Supabase Edge Function 传 `/ugs-metadata`，本地模式留空。
   * 传入的值会被规范成「要么是空串，要么以 / 开头且不以 / 结尾」。
   */
  basePath?: string;
}

/** 把前缀规范成 Hono `basePath()` 期望的格式。 */
export function normalizeBasePath(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (value === "" || value === "/") return "";
  // 去掉首尾斜杠并合并重复斜杠，例如 "//api//v1//" → "/api/v1"
  const segments = value.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "" : "/" + segments.join("/");
}

/**
 * 创建 UGS Metadata Server 的 Hono 应用。
 *
 * 所有 `/api/*` 路径与原始 ASP.NET MetadataServer 保持 1:1 兼容，
 * UGS 客户端无需任何改动。
 */
export function createApp(options: AppOptions = {}): Hono {
  const basePath = normalizeBasePath(options.basePath);
  const app = basePath ? new Hono().basePath(basePath) : new Hono();

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

  // 简单存活检查（不访问数据库，保持与旧版本响应一致）
  app.get("/", (c) => c.json({ status: "ok", service: "UGS Metadata Server" }));

  // 就绪检查：会真正 ping 一次数据库，因此可以用于 Docker healthcheck
  app.get("/health", async (c) => {
    try {
      const driver = await getDriver();
      await driver.sql`SELECT 1`;
      return c.json({
        status: "ok",
        service: "UGS Metadata Server",
        driver: driver.name,
        target: driver.target,
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
