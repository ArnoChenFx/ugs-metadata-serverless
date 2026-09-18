/**
 * SQLite 驱动 —— 让整个服务可以在没有任何外部数据库的情况下纯本地运行。
 *
 * 实现要点：
 *
 * 1. 复用 Node 内置的 `node:sqlite`（Deno 2 通过 Node 兼容层提供，底层为真实 SQLite，
 *    当前版本 3.5x），因此**不需要任何第三方依赖**，也不需要安装原生模块。
 * 2. 路由层写的是 postgres.js 风格的模板 SQL，这里做一层「方言翻译」：
 *    - `${值}` 插值 → `?` 位置占位符（参数按顺序绑定，天然防注入）
 *    - `NOW() AT TIME ZONE 'utc'` → `strftime(...)`（SQLite 没有 `AT TIME ZONE`）
 *    - `${x}::jsonb` 这类 Postgres 类型转换 → 直接去掉（SQLite 弱类型）
 * 3. 参数值做归一化：SQLite 只接受 null / number / bigint / string / Uint8Array，
 *    因此 `undefined` → NULL、`true/false` → 1/0、`Date` → 时间字符串、其余对象 → JSON 文本。
 * 4. 打开数据库时自动执行 `schema.sqlite.sql`（全部语句都是幂等的），首次运行无需手工建表。
 *
 * 已知行为差异（可接受，见 README「双模式差异」）：
 *   - SQLite 的 `LIKE` 对 ASCII 默认不区分大小写，Postgres 区分；路由层本来就用 JS
 *     做了一遍精确的大小写无关过滤，因此对外的返回结果是一致的。
 *   - SQLite 没有真正的布尔列，布尔值以 0/1 保存。
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import type { Row, SqlDriver, SqlTag } from "./types.ts";

/** 未配置 `SQLITE_PATH` 时默认使用的数据库文件（相对进程工作目录）。 */
export const DEFAULT_SQLITE_PATH = "./data/ugs.db";

/** 内存库的特殊路径，测试用。 */
export const MEMORY_PATH = ":memory:";

/** 预编译语句缓存容量上限，超出后整体清空（避免长期运行内存缓慢增长）。 */
const STATEMENT_CACHE_LIMIT = 128;

/**
 * `node:sqlite` 允许绑定的参数类型。
 * 参考：https://nodejs.org/api/sqlite.html#statementstally
 */
export type SqliteParam = null | number | bigint | string | Uint8Array;

/**
 * Postgres → SQLite 的 SQL 方言重写规则。
 *
 * 注意：这些正则会作用于整条 SQL 文本。当前项目的 SQL 里不会在字符串字面量中出现
 * `::` 或 `AT TIME ZONE`，所以是安全的；后续新增 SQL 时请留意这一点。
 */
export const DIALECT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // NOW() AT TIME ZONE 'utc' → 「YYYY-MM-DD HH:MM:SS.mmm」格式的 UTC 时间字符串。
  // 与 Postgres 的 timestamp（无时区）返回格式基本一致，UGS 客户端可直接解析。
  [
    /\bNOW\s*\(\s*\)\s*AT\s+TIME\s+ZONE\s*'utc'/gi,
    "strftime('%Y-%m-%d %H:%M:%f','now')",
  ],
  // 去掉 Postgres 的显式类型转换（如 `${json}::jsonb`）。SQLite 是弱类型的，不需要它。
  [
    /::\s*(?:jsonb|json|text|varchar|character\s+varying|int|integer|int2|int4|int8|bigint|smallint|boolean|bool|timestamptz|timestamp|date|numeric|decimal|real|double\s+precision)\b/gi,
    "",
  ],
];

/**
 * 对单条 SQL 文本应用 Postgres → SQLite 的方言重写。
 * 导出出来是为了让单元测试可以直接验证翻译结果。
 */
export function applyDialect(sqlText: string): string {
  let out = sqlText;
  for (const [pattern, replacement] of DIALECT_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 把 postgres.js 风格的模板字符串转换成 SQLite 的 `?` 占位符版本。
 *
 * postgres.js 会把 `${值}` 编译成 `$1`、`$2`…；SQLite 使用位置占位符 `?`，
 * 并且参数按传入顺序绑定，所以这里只需要把每个插值点替换成 `?`。
 */
export function toSqliteSql(strings: TemplateStringsArray): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < strings.length - 1) out += "?";
  }
  return applyDialect(out);
}

/**
 * 把 `Date` 格式化成与 `strftime('%Y-%m-%d %H:%M:%f','now')` 一致的 UTC 字符串，
 * 保证同库里写入 / 生成的时间戳格式统一。
 */
export function formatUtcTimestamp(date: Date): string {
  const iso = date.toISOString(); // 2026-09-18T09:32:48.778Z
  return iso.slice(0, 10) + " " + iso.slice(11, 23);
}

/**
 * 把任意 JS 值归一化成 SQLite 可绑定的参数。
 * 导出出来是为了让单元测试可以直接验证归一化结果。
 */
export function normalizeParam(value: unknown): SqliteParam {
  if (value === undefined || value === null) return null;

  switch (typeof value) {
    case "boolean":
      // SQLite 没有布尔类型，统一转成 0/1（`CASE WHEN ? THEN` 也能正确工作）
      return value ? 1 : 0;
    case "number":
      // NaN / Infinity 绑定会抛错，退化成 NULL 更符合「值缺失」的语义
      return Number.isFinite(value) ? value : null;
    case "bigint":
    case "string":
      return value;
    default:
      break;
  }

  if (value instanceof Date) return formatUtcTimestamp(value);
  if (value instanceof Uint8Array) return value;

  // 其余情况（普通对象、数组等）统一序列化成 JSON 文本存储
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** 把 `node:sqlite` 返回的 null 原型对象转成普通对象，便于后续展开与序列化。 */
function toPlainRow(row: Record<string, unknown>): Row {
  return { ...row };
}

/** 驱动内部状态：同一个连接上的事务嵌套深度。 */
interface DriverState {
  txDepth: number;
}

/**
 * 基于一个已打开的 SQLite 连接创建统一的 `SqlTag`。
 *
 * @param db       已打开的 `DatabaseSync` 实例
 * @param state    事务嵌套深度等共享状态（事务内的 `tx` 与外部 `sql` 共用同一个连接）
 */
export function createSqlTag(db: DatabaseSync, state: DriverState): SqlTag {
  /** 预编译语句缓存：同一个 SQL 文本只 prepare 一次。 */
  const statements = new Map<string, StatementSync>();

  function prepare(sqlText: string): StatementSync {
    let statement = statements.get(sqlText);
    if (!statement) {
      statement = db.prepare(sqlText);
      if (statements.size >= STATEMENT_CACHE_LIMIT) statements.clear();
      statements.set(sqlText, statement);
    }
    return statement;
  }

  const execute = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> => {
    const sqlText = toSqliteSql(strings);
    const params = values.map(normalizeParam);
    // `.all()` 会返回全部结果行：
    //   - SELECT / 带 RETURNING 的写语句 → 结果行
    //   - 普通 INSERT / UPDATE / DELETE   → 空数组
    // node:sqlite 是同步 API，这里用 Promise.resolve 包一层以满足统一的异步接口
    const rows = prepare(sqlText).all(...params) as Record<string, unknown>[];
    return Promise.resolve(rows.map(toPlainRow));
  };

  const begin = async <T>(callback: (tx: SqlTag) => Promise<T>): Promise<T> => {
    // 嵌套事务用 SAVEPOINT 模拟，保证内层回滚不会连带撤销外层已做的修改
    const nested = state.txDepth > 0;
    const savepoint = `ugs_sp_${state.txDepth}`;

    db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    state.txDepth++;

    try {
      const result = await callback(tag);
      state.txDepth--;
      db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      state.txDepth--;
      try {
        db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      } catch {
        // 回滚本身失败（例如连接已关闭）时忽略，向上抛出原始异常更有价值
      }
      throw error;
    }
  };

  const tag = Object.assign(execute, {
    begin,
    end: (): Promise<void> => {
      statements.clear();
      db.close();
      return Promise.resolve();
    },
  }) as SqlTag;

  return tag;
}

/** SQLite 驱动的可配置项。 */
export interface SqliteDriverOptions {
  /** 数据库文件路径；`":memory:"` 表示内存库。默认取 `SQLITE_PATH`，再退回 `./data/ugs.db`。 */
  path?: string;
  /** 是否自动应用 schema（默认 true）。测试里可以关掉以验证「无表时报错」等场景。 */
  applySchema?: boolean;
  /** schema 文件路径，默认使用与本文件同级的 `../schema.sqlite.sql`。 */
  schemaPath?: string | URL;
}

/** 解析最终使用的数据库文件路径。 */
export function resolveSqlitePath(): string {
  const raw = Deno.env.get("SQLITE_PATH")?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SQLITE_PATH;
}

/**
 * 读取并执行 SQLite schema。
 *
 * schema 里全部是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
 * 因此每次打开数据库都执行一遍是幂等且安全的（新表 / 新索引会自动补齐）。
 */
export function applySqliteSchema(
  db: DatabaseSync,
  schemaPath?: string | URL,
): void {
  const path = schemaPath ?? new URL("../schema.sqlite.sql", import.meta.url);
  const ddl = Deno.readTextFileSync(path);
  db.exec(ddl);
}

/** SQLite 的推荐 PRAGMA 设置。 */
function applyPragmas(db: DatabaseSync, isMemory: boolean): void {
  // 外键约束默认关闭，必须显式打开，否则 issue_* 系列的 REFERENCES 形同虚设
  db.exec("PRAGMA foreign_keys = ON;");
  // WAL 并发读写更友好（内存库不支持，会自动退化为 memory 模式）
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
    // NORMAL 在 WAL 下兼顾安全与性能；数据库损坏只会发生在操作系统崩溃时
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  // 多进程/多连接同时写入时等待锁，而不是立刻抛 SQLITE_BUSY
  db.exec("PRAGMA busy_timeout = 5000;");
}

/**
 * 创建 SQLite 驱动实例。
 *
 * 会完成：建目录 → 打开文件 → 设置 PRAGMA → 应用 schema。
 * 这些操作全部是同步的（node:sqlite 的 API 也是同步的），
 * 之所以返回 Promise，只是为了与统一的异步驱动工厂接口保持一致。
 */
export function createSqlDriver(
  options: SqliteDriverOptions = {},
): Promise<SqlDriver> {
  const path = options.path ?? resolveSqlitePath();
  const isMemory = path === MEMORY_PATH || path === "";

  if (!isMemory) {
    // 保证父目录存在，否则首次运行时打开数据库会直接失败
    const parent = dirname(path);
    if (parent && parent !== "." && parent !== path) {
      Deno.mkdirSync(parent, { recursive: true });
    }
  }

  const db = new DatabaseSync(path);
  applyPragmas(db, isMemory);

  if (options.applySchema !== false) {
    applySqliteSchema(db, options.schemaPath);
  }

  const state: DriverState = { txDepth: 0 };

  return Promise.resolve({
    name: "sqlite",
    sql: createSqlTag(db, state),
    target: isMemory ? "sqlite::memory:" : `sqlite:${path}`,
  });
}
