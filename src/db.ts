/**
 * 数据库门面。
 *
 * 职责有两块：
 *
 * 1. **连接生命周期**：`initDatabase()` / `closeDatabase()` 显式管理那唯一一个 SQLite 连接。
 *    入口（`server.ts`）与测试（`test/`）在启动时各调用一次，之后路由层就可以直接用 `sql`。
 * 2. **公共 SQL 辅助**：项目与用户的「查不到就建」逻辑，被多个路由复用。
 *
 * 路由层只 import `sql`、`getOrCreateProjectId`、`findOrAddUserId` 这三样东西，
 * 不需要知道数据库放在哪、什么时候打开、什么时候关闭。
 */

import {
  type Database,
  openDatabase,
  type OpenDatabaseOptions,
  type Row,
  type SqlExecutor,
} from "./sqlite.ts";

export type { Database, Row, SqlExecutor };

/** 当前打开的数据库；未初始化时为 null。 */
let database: Database | null = null;

/**
 * 打开数据库（幂等）。
 *
 * `path` 缺省时按 `SQLITE_PATH` 环境变量 → `./data/ugs.db` 的顺序解析；
 * 目录不存在会自动创建，建表脚本会幂等执行，因此首次运行无需任何准备工作。
 */
export function initDatabase(options: OpenDatabaseOptions = {}): Database {
  if (database) return database;
  database = openDatabase(options);
  console.log(`[db] 已打开数据库：${database.path}`);
  return database;
}

/** 取当前数据库；尚未初始化时抛出明确错误。 */
export function getDatabase(): Database {
  if (!database) {
    throw new Error(
      "数据库尚未初始化，请先调用 initDatabase()（服务入口会自行调用）。",
    );
  }
  return database;
}

/** 数据库是否已打开。 */
export function isDatabaseOpen(): boolean {
  return database !== null;
}

/** 关闭数据库并释放文件句柄。重复调用安全。 */
export function closeDatabase(): void {
  if (!database) return;
  database.close();
  database = null;
}

/**
 * 路由层使用的 SQL 执行器。
 *
 * 它只是把调用转发给当前数据库，所以路由代码里写：
 *
 * ```ts
 * const rows = await sql`SELECT id FROM badges WHERE id > ${lastId}`;
 * await sql.begin(async (tx) => {
 *   await tx`DELETE FROM issue_builds WHERE issue_id = ${issueId}`;
 * });
 * ```
 */
export const sql: SqlExecutor = Object.assign(
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> => getDatabase()(strings, ...values),
  {
    begin: <T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T> =>
      getDatabase().begin(callback),
  },
) as SqlExecutor;

// ---------------------------------------------------------------------------
// 公共 SQL 辅助
// ---------------------------------------------------------------------------

/**
 * 按名称查找项目，不存在则创建，返回其 id。
 *
 * `ON CONFLICT ... DO UPDATE ... RETURNING` 在 SQLite 3.35+ 可用，
 * 这里利用它把「查不到就插入」压缩成一条语句，避免并发下的竞态。
 */
export async function getOrCreateProjectId(
  projectName: string,
): Promise<number> {
  const [row] = await sql`
    INSERT INTO projects (name) VALUES (${projectName})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return Number(row.id);
}

/**
 * 按名称查找用户，不存在则创建，返回其 id。
 * 用户名统一转成大写存储（与原始 ASP.NET 版本一致），空名称返回 -1。
 */
export async function findOrAddUserId(name: string): Promise<number> {
  if (!name || name.length === 0) return -1;
  const normalized = name.toUpperCase();
  const [row] = await sql`
    INSERT INTO users (name) VALUES (${normalized})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return Number(row.id);
}
