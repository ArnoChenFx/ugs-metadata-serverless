/**
 * SQLite 存储层。
 *
 * 整个服务只依赖这一个数据库：一个本地 SQLite 文件（或内存库），通过 Deno 内置的
 * `node:sqlite` 访问 —— 不需要第三方依赖，不需要安装原生模块，也不需要外部服务。
 *
 * 路由层用模板字符串写参数化 SQL：
 *
 * ```ts
 * const rows = await db`SELECT id FROM badges WHERE id > ${lastId}`;
 * await db.begin(async (tx) => {
 *   await tx`DELETE FROM issues WHERE id = ${issueId}`;
 * });
 * ```
 *
 * 每个 `${值}` 都会被替换成 `?` 位置占位符，参数按顺序绑定，
 * 因此插进来的内容永远只是数据，不可能变成 SQL。
 *
 * ## 为什么参数要做归一化
 *
 * SQLite 的绑定接口只接受 `null` / `number` / `bigint` / `string` / `Uint8Array`。
 * 直接传 `boolean`、`undefined` 或对象会抛错，所以这里统一转换：
 *
 * | JS 值 | 绑定值 |
 * |---|---|
 * | `undefined` / `null` | `NULL` |
 * | `true` / `false` | `1` / `0` |
 * | `NaN` / `Infinity` | `NULL` |
 * | `Date` | `YYYY-MM-DD HH:MM:SS`（UTC 文本） |
 * | 对象 / 数组 | JSON 文本 |
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";

/** 未配置 `SQLITE_PATH` 时默认使用的数据库文件（相对进程工作目录）。 */
export const DEFAULT_DATABASE_PATH = "./data/ugs.db";

/** 内存库的特殊路径，主要用于测试。 */
export const MEMORY_PATH = ":memory:";

/** 预编译语句缓存的容量上限，超出后整体清空（避免长期运行内存缓慢增长）。 */
const STATEMENT_CACHE_LIMIT = 128;

/** 一行查询结果。列名到值。 */
export type Row = Record<string, unknown>;

/**
 * 路由层使用的能力：执行 SQL 与开启事务。
 *
 * 单独抽出来是为了让业务代码只依赖「能查能写能开事务」这一件事，
 * 而不用关心连接生命周期（那是 `db.ts` 的职责）。
 */
export interface SqlExecutor {
  /** 执行一条参数化 SQL，返回结果行数组（无 `RETURNING` 的写语句返回空数组）。 */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  /** 开启事务；回调抛出异常时自动回滚。支持嵌套（内部用 SAVEPOINT 实现）。 */
  begin<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** 一个已打开的数据库句柄。 */
export interface Database extends SqlExecutor {
  /** 数据库文件路径，或 `:memory:`。 */
  readonly path: string;
  /** 关闭连接并释放文件句柄。 */
  close(): void;
}

/** `node:sqlite` 允许绑定的参数类型。 */
export type SqliteParam = null | number | bigint | string | Uint8Array;

/**
 * 把模板字符串转换成 SQLite 的位置占位符版本。
 *
 * 每个 `${值}` 插值点替换成 `?`，参数随后按同样顺序绑定。
 */
export function toParameterizedSql(strings: TemplateStringsArray): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < strings.length - 1) out += "?";
  }
  return out;
}

/**
 * 把 `Date` 格式化成与 SQL 里 `CURRENT_TIMESTAMP` 一致的 `YYYY-MM-DD HH:MM:SS`（UTC），
 * 保证写进同一张表的时间戳格式统一、可直接按字符串排序比较。
 */
export function formatUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
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

/** 驱动内部状态：当前连接上的事务嵌套深度。 */
interface ConnectionState {
  txDepth: number;
}

/** 内部使用：额外携带预编译语句缓存的执行器，便于关闭时一并清理。 */
interface ExecutorInternal extends SqlExecutor {
  readonly statements: Map<string, StatementSync>;
}

/** 把 `node:sqlite` 返回的 null 原型对象转成普通对象，便于展开与序列化。 */
function toPlainRow(row: Record<string, unknown>): Row {
  return { ...row };
}

/**
 * 基于一个已打开的连接创建 SQL 执行器。
 *
 * @param db     已打开的 `DatabaseSync` 实例
 * @param state  事务嵌套深度等共享状态（事务内的 `tx` 与外部 `db` 共用同一个连接）
 */
function createExecutor(
  db: DatabaseSync,
  state: ConnectionState,
): ExecutorInternal {
  /** 预编译语句缓存：同一个 SQL 文本只 prepare 一次。 */
  const statements = new Map<string, StatementSync>();

  function prepare(sqlText: string): StatementSync {
    let statement = statements.get(sqlText);
    if (!statement) {
      statement = db.prepare(sqlText);
      // 缓存满了直接整体清空：比实现 LRU 简单，且命中率依旧很高
      if (statements.size >= STATEMENT_CACHE_LIMIT) statements.clear();
      statements.set(sqlText, statement);
    }
    return statement;
  }

  const execute = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> => {
    try {
      const sqlText = toParameterizedSql(strings);
      const params = values.map(normalizeParam);
      // `.all()` 会返回全部结果行：
      //   - SELECT / 带 RETURNING 的写语句 → 结果行
      //   - 普通 INSERT / UPDATE / DELETE   → 空数组
      const rows = prepare(sqlText).all(...params) as Record<string, unknown>[];
      return Promise.resolve(rows.map(toPlainRow));
    } catch (error) {
      // node:sqlite 是同步 API，SQL 语法错误等会直接抛出。
      // 这里统一转成 rejected promise，保证「返回 Promise 的函数绝不同步抛错」，
      // 调用方可以放心地用 await / .catch() / Promise.all() 处理。
      return Promise.reject(error);
    }
  };

  const begin = async <T>(
    callback: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> => {
    // 嵌套事务用 SAVEPOINT 模拟，保证内层回滚不会连带撤销外层已做的修改
    const nested = state.txDepth > 0;
    const savepoint = `ugs_sp_${state.txDepth}`;

    db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    state.txDepth++;

    try {
      const result = await callback(executor);
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

  const executor = Object.assign(execute, {
    begin,
    statements,
  }) as ExecutorInternal;

  return executor;
}

/** SQLite 的推荐 PRAGMA 设置。 */
function applyPragmas(db: DatabaseSync, isMemory: boolean): void {
  // 外键约束默认关闭，必须显式打开，否则 issue_* 系列的 REFERENCES 形同虚设
  db.exec("PRAGMA foreign_keys = ON;");
  if (!isMemory) {
    // WAL 让读写并发更友好（内存库不支持，会自动保持 memory 模式）
    db.exec("PRAGMA journal_mode = WAL;");
    // NORMAL 在 WAL 下兼顾安全与性能；数据库损坏只会发生在操作系统崩溃时
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  // 多进程/多连接同时写入时等待锁，而不是立刻抛 SQLITE_BUSY
  db.exec("PRAGMA busy_timeout = 5000;");
}

/**
 * 执行建表脚本。
 *
 * `schema.sql` 里全部是 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，
 * 因此每次打开数据库都执行一遍是幂等且安全的：新表、新索引在下次启动时自动补齐。
 */
export function applySchema(db: DatabaseSync, schemaPath?: string | URL): void {
  const path = schemaPath ?? new URL("./schema.sql", import.meta.url);
  db.exec(Deno.readTextFileSync(path));
}

/** 打开数据库的选项。 */
export interface OpenDatabaseOptions {
  /** 数据库文件路径；`":memory:"` 表示内存库。默认取 `SQLITE_PATH`，再退回 `./data/ugs.db`。 */
  path?: string;
  /** 是否自动应用 `schema.sql`，默认 `true`。 */
  applySchema?: boolean;
  /** 建表脚本路径，默认使用与本文件同级的 `schema.sql`。 */
  schemaPath?: string | URL;
}

/** 解析最终使用的数据库文件路径（环境变量 → 默认值）。 */
export function resolveDatabasePath(): string {
  const raw = Deno.env.get("SQLITE_PATH")?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_DATABASE_PATH;
}

/**
 * 打开数据库。
 *
 * 完成：建目录 → 打开文件 → 设置 PRAGMA → 执行建表脚本。
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Database {
  const path = options.path ?? resolveDatabasePath();
  const isMemory = path === MEMORY_PATH || path === "";

  if (!isMemory) {
    // 保证父目录存在，否则首次运行时打开数据库会直接失败
    const parent = dirname(path);
    if (parent && parent !== "." && parent !== path) {
      Deno.mkdirSync(parent, { recursive: true });
    }
  }

  const handle = new DatabaseSync(path);
  applyPragmas(handle, isMemory);

  if (options.applySchema !== false) {
    applySchema(handle, options.schemaPath);
  }

  const state: ConnectionState = { txDepth: 0 };
  const executor = createExecutor(handle, state);

  return Object.assign(executor, {
    path: isMemory ? MEMORY_PATH : path,
    close: (): void => {
      executor.statements.clear();
      handle.close();
    },
  }) as Database;
}
