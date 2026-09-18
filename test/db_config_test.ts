/**
 * 驱动选择与路径规范化单元测试。
 *
 * 这里不修改全局环境变量，而是给 `resolveDriverName` 注入一个假的 env 读取函数，
 * 这样测试之间互不影响。
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  normalizeDriverName,
  resolveDriverName,
} from "../supabase/functions/ugs-metadata/db.ts";
import { normalizeBasePath } from "../supabase/functions/ugs-metadata/app.ts";

/** 用普通对象模拟环境变量读取。 */
function fakeEnv(
  values: Record<string, string>,
): (key: string) => string | undefined {
  return (key) => values[key];
}

Deno.test("normalizeDriverName: 接受常见别名", () => {
  for (const raw of ["postgres", "Postgres", "postgresql", "PG", "  pg  "]) {
    assertEquals(normalizeDriverName(raw), "postgres");
  }
  for (const raw of ["sqlite", "SQLite", "sqlite3", "local"]) {
    assertEquals(normalizeDriverName(raw), "sqlite");
  }
  assertEquals(normalizeDriverName("mysql"), null);
  assertEquals(normalizeDriverName(""), null);
});

Deno.test("resolveDriverName: DB_DRIVER 显式指定时优先级最高", () => {
  assertEquals(
    resolveDriverName(
      fakeEnv({ DB_DRIVER: "sqlite", DATABASE_URL: "postgres://x" }),
    ),
    "sqlite",
  );
  assertEquals(
    resolveDriverName(fakeEnv({ DB_DRIVER: "postgres" })),
    "postgres",
  );
});

Deno.test("resolveDriverName: 存在连接串时默认为 postgres", () => {
  assertEquals(
    resolveDriverName(fakeEnv({ SUPABASE_DB_URL: "postgres://supabase" })),
    "postgres",
  );
  assertEquals(
    resolveDriverName(fakeEnv({ DATABASE_URL: "postgres://self-hosted" })),
    "postgres",
  );
});

Deno.test("resolveDriverName: 无任何配置时回落到 sqlite（纯本地开箱即用）", () => {
  assertEquals(resolveDriverName(fakeEnv({})), "sqlite");
  assertEquals(
    resolveDriverName(fakeEnv({ SQLITE_PATH: "./data/ugs.db" })),
    "sqlite",
  );
});

Deno.test("resolveDriverName: 非法 DB_DRIVER 直接报错而不是静默回落", () => {
  assertThrows(
    () => resolveDriverName(fakeEnv({ DB_DRIVER: "mysql" })),
    Error,
    "无法识别 DB_DRIVER",
  );
});

Deno.test("normalizeBasePath: 规范成 Hono basePath 期望的格式", () => {
  assertEquals(normalizeBasePath(undefined), "");
  assertEquals(normalizeBasePath(null), "");
  assertEquals(normalizeBasePath(""), "");
  assertEquals(normalizeBasePath("/"), "");
  assertEquals(normalizeBasePath("ugs-metadata"), "/ugs-metadata");
  assertEquals(normalizeBasePath("/ugs-metadata"), "/ugs-metadata");
  assertEquals(normalizeBasePath("/ugs-metadata/"), "/ugs-metadata");
  assertEquals(normalizeBasePath("  //api//v1//  "), "/api/v1");
});
