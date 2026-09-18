/**
 * SQLite 存储层单元测试。
 *
 * 覆盖三类容易出错的地方：
 *   1. 模板字符串 → 位置占位符的转换
 *   2. JS 值 → SQLite 可绑定参数的归一化
 *   3. 事务（提交 / 回滚 / 嵌套 savepoint）、语句缓存与 schema 初始化
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  formatUtcTimestamp,
  MEMORY_PATH,
  normalizeParam,
  openDatabase,
  toParameterizedSql,
} from "../src/sqlite.ts";

// ---------------------------------------------------------------------------
// 占位符转换
// ---------------------------------------------------------------------------

/** 在模板标签里捕获转换后的 SQL 文本。 */
function captureSql(
  strings: TemplateStringsArray,
  ..._values: unknown[]
): string {
  return toParameterizedSql(strings);
}

Deno.test("toParameterizedSql: 插值点全部变成 ? 位置占位符", () => {
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
  // 插值紧跟标点时不能多出空格
  assertEquals(
    captureSql`SELECT * FROM t WHERE a = ${1}, b = ${2}`,
    "SELECT * FROM t WHERE a = ?, b = ?",
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
  assertEquals(normalizeParam(Number.NEGATIVE_INFINITY), null);
});

Deno.test("normalizeParam: Date 转成与 CURRENT_TIMESTAMP 一致的 UTC 文本", () => {
  const date = new Date("2026-01-02T03:04:05.678Z");
  assertEquals(normalizeParam(date), "2026-01-02 03:04:05");
  assertEquals(formatUtcTimestamp(date), "2026-01-02 03:04:05");
});

Deno.test("normalizeParam: 对象/数组序列化为 JSON 文本", () => {
  assertEquals(normalizeParam({ Links: [] }), '{"Links":[]}');
  assertEquals(normalizeParam([1, 2]), "[1,2]");
});

// ---------------------------------------------------------------------------
// 打开数据库与 schema
// ---------------------------------------------------------------------------

Deno.test("openDatabase: 打开内存库时自动建出全部表", async () => {
  const db = openDatabase({ path: MEMORY_PATH });
  assertEquals(db.path, MEMORY_PATH);

  const tables = await db`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  const names = tables.map((row) => row.name as string);

  for (const expected of [
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
  ]) {
    assertEquals(names.includes(expected), true, `缺少表 ${expected}`);
  }

  db.close();
});

Deno.test("openDatabase: 自动创建数据库文件所在的多层目录", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "ugs-sqlite-" });
  const dbPath = `${tempDir}/nested/deeper/ugs.db`;
  try {
    const db = openDatabase({ path: dbPath });
    await db`INSERT INTO projects (name) VALUES (${"//depot/main"})`;
    db.close();

    const stat = await Deno.stat(dbPath);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("openDatabase: applySchema=false 时不会建表", async () => {
  const db = openDatabase({ path: MEMORY_PATH, applySchema: false });
  // 表不存在，查询会失败
  await assertRejects(() => db`SELECT * FROM badges`);
  db.close();
});

Deno.test("openDatabase: applySchema=false 时仍可自行建表并正常读写", async () => {
  const db = openDatabase({ path: MEMORY_PATH, applySchema: false });

  // 没有插值的 SQL 会原样执行，因此 DDL 也能通过同一个执行器跑
  await db`CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`;
  await db`INSERT INTO t (v) VALUES (${"hello"})`;

  const rows = await db`SELECT v FROM t`;
  assertEquals(rows[0].v, "hello");
  db.close();
});

Deno.test("openDatabase: 返回行的原型是普通对象", async () => {
  const db = openDatabase({ path: MEMORY_PATH });
  const rows = await db`SELECT 1 AS ok`;
  assertEquals(Object.getPrototypeOf(rows[0]), Object.prototype);
  assertEquals(rows[0].ok, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

/** 创建一个指向内存库的数据库句柄。 */
function memoryDatabase() {
  return openDatabase({ path: MEMORY_PATH });
}

Deno.test("事务：提交后数据可见", async () => {
  const db = memoryDatabase();
  await db.begin(async (tx) => {
    await tx`INSERT INTO users (name) VALUES (${"ALICE"})`;
    await tx`INSERT INTO users (name) VALUES (${"BOB"})`;
  });
  const rows = await db`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["ALICE", "BOB"]);
  db.close();
});

Deno.test("事务：回调抛异常时整体回滚", async () => {
  const db = memoryDatabase();
  await db.begin(async (tx) => {
    await tx`INSERT INTO users (name) VALUES (${"CAROL"})`;
  });

  await assertRejects(
    async () => {
      await db.begin(async (tx) => {
        await tx`INSERT INTO users (name) VALUES (${"DAVE"})`;
        throw new Error("模拟业务失败");
      });
    },
    Error,
    "模拟业务失败",
  );

  const rows = await db`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["CAROL"]);
  db.close();
});

Deno.test("事务：嵌套事务内层回滚不影响外层", async () => {
  const db = memoryDatabase();
  await db.begin(async (tx) => {
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

  const rows = await db`SELECT name FROM users ORDER BY name`;
  assertEquals(rows.map((r) => r.name), ["AFTER", "OUTER"]);
  db.close();
});

// ---------------------------------------------------------------------------
// 语句缓存、绑定安全与时间戳格式
// ---------------------------------------------------------------------------

Deno.test("语句缓存：同一 SQL 反复执行结果一致", async () => {
  const db = memoryDatabase();
  for (const name of ["A", "B", "C"]) {
    await db`INSERT INTO users (name) VALUES (${name})`;
  }
  const first = await db`SELECT id, name FROM users WHERE name = ${"B"}`;
  const second = await db`SELECT id, name FROM users WHERE name = ${"B"}`;
  assertEquals(first, second);
  assertEquals(first[0].name, "B");
  db.close();
});

Deno.test("绑定安全：注入内容被当作纯数据", async () => {
  const db = memoryDatabase();
  const evil = "x'; DROP TABLE users; --";
  await db`INSERT INTO users (name) VALUES (${evil})`;
  const rows = await db`SELECT name FROM users`;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, evil);
  db.close();
});

Deno.test("时间戳：CURRENT_TIMESTAMP 与 schema 默认值格式一致", async () => {
  const db = memoryDatabase();
  const pattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

  const [now] = await db`
    SELECT CURRENT_TIMESTAMP AS value, typeof(CURRENT_TIMESTAMP) AS kind
  `;
  assertEquals(now.kind, "text");
  assertEquals(pattern.test(String(now.value)), true);

  await db`INSERT INTO issues (project, summary) VALUES (${"//depot/main"}, ${"标题"})`;
  const [issue] = await db`SELECT created_at FROM issues`;
  assertEquals(pattern.test(String(issue.created_at)), true);

  db.close();
});
