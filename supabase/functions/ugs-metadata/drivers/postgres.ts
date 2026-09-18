/**
 * PostgreSQL 驱动 —— 保持项目原有的 serverless / Supabase 部署能力。
 *
 * 底层仍然是 postgres.js，只是把它包装成统一的 `SqlDriver` 接口，
 * 让路由层可以与 SQLite 驱动共用同一份代码。
 */

import postgres from "postgres";
import type { SqlDriver, SqlTag } from "./types.ts";

/** 按优先级检查的 Postgres 连接串环境变量。 */
const POSTGRES_URL_VARS = ["SUPABASE_DB_URL", "DATABASE_URL"] as const;

/**
 * 解析 Postgres 连接串。
 * Supabase Edge Function 运行时会自动注入 `SUPABASE_DB_URL`；
 * 自建场景通常使用 `DATABASE_URL`。
 */
export function resolveDatabaseUrl(): string {
  for (const key of POSTGRES_URL_VARS) {
    const value = Deno.env.get(key)?.trim();
    if (value) return value;
  }
  throw new Error(
    `Postgres 模式需要设置 ${POSTGRES_URL_VARS.join(" 或 ")} 环境变量，` +
      `或者改用纯本地模式（DB_DRIVER=sqlite）。`,
  );
}

/** 把连接串里的密码替换成 `***`，避免密码出现在日志或 /health 响应中。 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    // 非标准连接串直接返回原值（解析失败通常意味着里面也没有密码）
    return url;
  }
}

/**
 * 创建 Postgres 驱动实例。
 *
 * postgres.js 返回的 `sql` 本身就是「可调用 + 带 .begin / .end」的形状，
 * 与我们的 `SqlTag` 接口一致，因此这里只需要做一次类型收窄。
 *
 * 注：建立连接是同步的（postgres.js 真连接时才握手），但驱动工厂的约定是异步的，
 * 因此这里返回 `Promise.resolve(...)` 而不是把函数标成 `async`。
 */
export function createSqlDriver(): Promise<SqlDriver> {
  const databaseUrl = resolveDatabaseUrl();

  const client = postgres(databaseUrl, {
    // 使用 Supabase 连接池（pgBouncer transaction 模式）时必须关闭预编译语句
    prepare: false,
    max: 10,
    idle_timeout: 20,
  });

  return Promise.resolve({
    name: "postgres",
    sql: client as unknown as SqlTag,
    target: `postgres:${redactDatabaseUrl(databaseUrl)}`,
  });
}
