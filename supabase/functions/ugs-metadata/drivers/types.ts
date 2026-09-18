/**
 * 数据库驱动抽象层。
 *
 * 项目同时支持两种后端：
 *
 *   - `postgres`：Supabase / 自建 PostgreSQL，走 serverless 部署路径（原有行为）。
 *   - `sqlite`  ：纯本地单文件数据库，零外部依赖，适合本地联调、单机自建、离线演示。
 *
 * 路由层只依赖下面这个统一的 `SqlTag` 接口，因此两种驱动可以共享同一份业务代码，
 * 新增接口时不需要区分后端。
 */

/**
 * 查询返回的一行数据。
 * 两种驱动都返回「列名 -> 值」的普通对象（SQLite 驱动会做一次拷贝，去掉 null 原型）。
 */
export type Row = Record<string, unknown>;

/**
 * 与 postgres.js 的 `sql` 模板标签完全一致的调用方式。
 *
 * 路由层用法（两种驱动写法相同）：
 *
 * ```ts
 * const rows = await sql`SELECT * FROM badges WHERE id > ${lastId}`;
 * await sql.begin(async (tx) => {
 *   await tx`DELETE FROM issue_builds WHERE issue_id = ${id}`;
 * });
 * ```
 */
export interface SqlTag {
  /** 执行一条参数化 SQL，返回结果行数组（写语句无 RETURNING 时返回空数组）。 */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  /** 开启事务；回调抛出异常时自动回滚。支持嵌套（内部用 SAVEPOINT 实现）。 */
  begin<T>(callback: (tx: SqlTag) => Promise<T>): Promise<T>;
  /** 关闭底层连接 / 文件句柄。 */
  end(options?: { timeout?: number }): Promise<void>;
}

/** 支持的驱动名称。 */
export type DriverName = "postgres" | "sqlite";

/** 一个已经初始化完成的驱动实例。 */
export interface SqlDriver {
  /** 驱动名称。 */
  readonly name: DriverName;
  /** 统一的 SQL 标签实现。 */
  readonly sql: SqlTag;
  /** 驱动目标的可读描述，用于日志与 `/health` 输出（不包含敏感信息）。 */
  readonly target: string;
}

/** 每个驱动模块统一导出这个工厂函数，由 `db.ts` 在运行时按需加载。 */
export type SqlDriverFactory = () => Promise<SqlDriver>;
