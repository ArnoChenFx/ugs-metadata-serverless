/**
 * SQLite 驱动单元测试。
 *
 * 覆盖三类容易出错的地方：
 *   1. Postgres → SQLite 的 SQL 方言翻译
 *   2. JS 值 → SQLite 可绑定参数的归一化
 *   3. 事务（提交 / 回滚 / 嵌套 savepoint）与预编译语句缓存
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  applyDialect,
  createSqlDriver,
  createSqlTag,
  formatUtcTimestamp,
  normalizeParam,
  toSqliteSql,
} from "../supabase/functions/ugs-metadata/drivers/sqlite.ts";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// 方言翻译
// ---------------------------------------------------------------------------

/** 在模板标签里捕获翻译后的 SQL 文本。 */
function captureSql(
  strings: TemplateStringsArray,
  ..._values: unknown[]
): string {
  return toSqliteSql(strings);
}

Deno.test("applyDialect: NOW() AT TIME ZONE 'utc' 被替换为 strftime", () => {
  assertEquals(
    applyDialect("SELECT NOW() AT TIME ZONE 'utc' AS t"),
    "SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS t",
  );
  // 大小写与空格容错
  assertEquals(
    applyDialect("select now()  at  time  zone  'UTC' as t"),
    "select strftime('%Y-%m-%d %H:%M:%f','now') as t",
  );
});

Deno.test("applyDialect: 去掉 Postgres 的 ::jsonb 等类型转换", () => {
  assertEquals(
    applyDialect("INSERT INTO x (m) VALUES ($1::jsonb)"),
    "INSERT INTO x (m) VALUES ($1)",
  );
  assertEquals(
    applyDialect("SELECT $1::text, $2::bigint, $3::VARCHAR"),
    "SELECT $1, $2, $3",
  );
});

Deno.test("toSqliteSql: 插值点全部变成 ? 位置占位符", () => {
  assertEquals(
    captureSql`SELECT * FROM badges WHERE id > ${1} AND name LIKE ${"x"} ORDER BY id`,
    "SELECT * FROM badges WHERE id > ? AND name LIKE ? ORDER BY id",
  );
  // 没有插值时原样输出
  assertEquals(captureSql`SELECT 1`, "SELECT 1");
  // 相邻插值
  assertEquals(
    captureSql`INSERT INTO t VALUES (${1}, ${2})`,
    "INSERT INTO t VALUES (?, ?)",
  );
  // 翻译与占位符可以同时生效
  assertEquals(
    captureSql`UPDATE t SET m = ${"{}"}::jsonb, u = NOW() AT TIME ZONE 'utc' WHERE id = ${3}`,
    "UPDATE t SET m = ?, u = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
  );
});

// ---------------------------------------------------------------------------
// 参数归一化
// ---------------------------------------------------------------------------

Deno.test("normalizeParam: undefined/null 统一为 NULL", () => {
  assertEquals(normalizeParam(undefined), null);
  assertEquals(normalizeParam(null), null);
});

Deno.test("normalizeParam: 布尔值转 0/1（SQLite 没有布尔类型）", () => {
  assertEquals(normalizeParam(true), 1);
  assertEquals(normalizeParam(false), 0);
});

Deno.test("normalizeParam: 数值/字符串/大整数原样保留", () => {
  assertEquals(normalizeParam(0), 0);
  assertEquals(normalizeParam(3.14), 3.14);
  assertEquals(normalizeParam(-1), -1);
  assertEquals(normalizeParam("x"), "x");
  assertEquals(normalizeParam(""), "");
  assertEquals(normalizeParam(10n), 10n);
});

Deno.test("normalizeParam: NaN / Infinity 退化为 NULL 而不是抛错", () => {
  assertEquals(normalizeParam(Number.NaN), null);
  assertEquals(normalizeParam(Number.POSITIVE_INFINITY), null);
});

Deno.test("normalizeParam: Date 转成与 strftime 一致的 UTC 字符串", () => {
  const date = new Date("2026-01-02T03:04:05.678Z");
  assertEquals(normalizeParam(date), "2026-01-02 03:04:05.678");
  assertEquals(formatUtcTimestamp(date), "2026-01-02 03:04:05.678");
});

Deno.test("normalizeParam: 对象/数组序列化为 JSON 文本", () => {
  assertEquals(normalizeParam({ Links: [] }), '{"Links":[]}');
  assertEquals(normalizeParam([1, 2]), "[1,2]");
});

// ---------------------------------------------------------------------------
// 事务与语句缓存
// ---------------------------------------------------------------------------

/** 创建一个指向内存库的驱动，方便各个测试独立使用。 */
async function memoryDriver() {
  return await createSqlDriver({ path: ":memory:" });
}

Deno.test("sqlite 驱动: 打开内存库时自动建表", async () => {
  const driver = await memoryDriver();
  const tables = await driver.sql`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  const names = tables.map((row) => row.name as string);
  for (
    const expected of [
      "badges",
      "cis",
      "comments",
      "errors",
      "issue_builds",
      "issue_diagnostics",
      "issue_watchers",
      "issues",
      "projects",
      "telemetry_v2",
      "user_votes",
      "users",
    ]
  ) {
    assertEquals(names.includes(expected), true, `缺少表 ${expected}`);
  }
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 事务提交后数据可见", async () => {
  const driver = await memoryDriver();
  await driver.sql.begin(async (tx) => {
    await tx`INSERT INTO users (name) VALUES (${"ALICE"})`;
    await tx`INSERT INTO users (name) VALUES (${"BOB"})`;
  });
  const rows = await driver.sql`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["ALICE", "BOB"]);
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 事务内抛异常时整体回滚", async () => {
  const driver = await memoryDriver();
  await driver.sql.begin(async (tx) => {
    await tx`INSERT INTO users (name) VALUES (${"CAROL"})`;
  });

  await assertRejects(
    async () => {
      await driver.sql.begin(async (tx) => {
        await tx`INSERT INTO users (name) VALUES (${"DAVE"})`;
        throw new Error("模拟业务失败");
      });
    },
    Error,
    "模拟业务失败",
  );

  const rows = await driver.sql`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["CAROL"]);
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 嵌套事务内层回滚不影响外层", async () => {
  const driver = await memoryDriver();
  await driver.sql.begin(async (tx) => {
    await tx`INSERT INTO users (name) VALUES (${"OUTER"})`;

    await assertRejects(async () => {
      await tx.begin(async (inner) => {
        await inner`INSERT INTO users (name) VALUES (${"INNER"})`;
        throw new Error("内层失败");
      });
    });

    // 外层继续写入，证明外层事务没有被内层回滚破坏
    await tx`INSERT INTO users (name) VALUES (${"AFTER"})`;
  });

  const rows = await driver.sql`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["AFTER", "OUTER"]);
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 预编译语句缓存复用（同一 SQL 反复执行结果一致）", async () => {
  const driver = await memoryDriver();
  for (const name of ["A", "B", "C"]) {
    await driver.sql`INSERT INTO users (name) VALUES (${name})`;
  }
  const first = await driver
    .sql`SELECT id, name FROM users WHERE name = ${"B"}`;
  const second = await driver
    .sql`SELECT id, name FROM users WHERE name = ${"B"}`;
  assertEquals(first, second);
  assertEquals(first[0].name, "B");
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 返回行为普通对象（非 null 原型）", async () => {
  const driver = await memoryDriver();
  const rows = await driver.sql`SELECT 1 AS ok`;
  assertEquals(Object.getPrototypeOf(rows[0]), Object.prototype);
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 参数按位置绑定，注入内容被当作纯数据", async () => {
  const driver = await memoryDriver();
  const evil = "x'; DROP TABLE users; --";
  await driver.sql`INSERT INTO users (name) VALUES (${evil})`;
  const rows = await driver.sql`SELECT name FROM users`;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, evil);
  await driver.sql.end();
});

Deno.test("sqlite 驱动: 自动创建数据库文件所在目录", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ugs-sqlite-driver-" });
  const dbPath = `${tempDir}/nested/deeper/ugs.db`;
  try {
    const driver = await createSqlDriver({ path: dbPath });
    await driver.sql`INSERT INTO projects (name) VALUES (${"//depot/main"})`;
    await driver.sql.end();

    const stat = await Deno.stat(dbPath);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createSqlTag: 可以脱离驱动单独使用（applySchema=false）", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
  const tag = createSqlTag(db, { txDepth: 0 });

  await tag`INSERT INTO t (v) VALUES (${"hello"})`;
  const rows = await tag`SELECT v FROM t`;
  assertEquals(rows[0].v, "hello");

  await tag.end();
});
