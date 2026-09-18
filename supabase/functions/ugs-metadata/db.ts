/**
 * 数据库门面（facade）。
 *
 * 本文件是整个项目唯一直接接触数据库的地方：路由层从这里拿到统一的 `sql` 标签，
 * 完全不需要知道自己跑在 PostgreSQL 还是 SQLite 上。
 *
 * 驱动选择规则（优先级从高到低）：
 *
 *   1. 显式设置 `DB_DRIVER=postgres` / `DB_DRIVER=sqlite`
 *   2. 存在 `SUPABASE_DB_URL` 或 `DATABASE_URL` → postgres
 *   3. 其余情况 → sqlite（纯本地模式，零配置开箱即用）
 *
 * 驱动是**懒加载**的：第一次真正执行 SQL 时才连接数据库 / 打开 SQLite 文件，
 * 这样单元测试可以先设置环境变量再构造应用。
 */

import type { DriverName, Row, SqlDriver, SqlTag } from "./drivers/types.ts";

export type { DriverName, Row, SqlDriver, SqlTag };

// ---------------------------------------------------------------------------
// 驱动选择
// ---------------------------------------------------------------------------

/** 显式指定驱动的环境变量名。 */
export const DRIVER_ENV_VAR = "DB_DRIVER";

/** 任一存在即视为应当使用 Postgres 的连接串变量。 */
const POSTGRES_URL_VARS = ["SUPABASE_DB_URL", "DATABASE_URL"] as const;

/** 把常见的别名归一化成标准驱动名；无法识别时返回 null。 */
export function normalizeDriverName(raw: string): DriverName | null {
  switch (raw.trim().toLowerCase()) {
    case "postgres":
    case "postgresql":
    case "pg":
      return "postgres";
    case "sqlite":
    case "sqlite3":
    case "local":
      return "sqlite";
    default:
      return null;
  }
}

/**
 * 决定当前进程使用哪个驱动。
 *
 * @param env 环境变量读取函数，默认读 `Deno.env`；测试时可注入固定值。
 */
export function resolveDriverName(
  env: (key: string) => string | undefined = (key) => Deno.env.get(key),
): DriverName {
  const explicit = env(DRIVER_ENV_VAR)?.trim();
  if (explicit) {
    const name = normalizeDriverName(explicit);
    if (name) return name;
    throw new Error(
      `无法识别 ${DRIVER_ENV_VAR}="${explicit}"，可选值：postgres | sqlite`,
    );
  }

  if (POSTGRES_URL_VARS.some((key) => env(key))) return "postgres";
  return "sqlite";
}

// ---------------------------------------------------------------------------
// 驱动实例（懒加载单例）
// ---------------------------------------------------------------------------

let driverPromise: Promise<SqlDriver> | null = null;

/**
 * 加载并初始化当前驱动（只执行一次）。
 *
 * 注意这里用的是**模板字符串**形式的动态 import，而不是字面量路径。
 * 原因是 Supabase Edge Function 的打包器（esbuild）会静态追踪字面量动态 import
 * 并把目标模块内联进产物，而 `drivers/sqlite.ts` 依赖 `node:sqlite`——
 * Supabase Edge Runtime 并不提供该模块，一旦被内联，云端部署会在加载阶段直接失败。
 * 用运行时拼接的说明符可以避免被打包器内联，只有真正选中该驱动时才会去加载。
 */
export function getDriver(): Promise<SqlDriver> {
  if (!driverPromise) {
    driverPromise = createDriver().catch((error) => {
      // 初始化失败时清空缓存，允许调用方修复环境后重试
      driverPromise = null;
      throw error;
    });
  }
  return driverPromise;
}

async function createDriver(): Promise<SqlDriver> {
  const name = resolveDriverName();
  const specifier = `./drivers/${name}.ts`;

  const module = (await import(specifier)) as {
    createSqlDriver: () => Promise<SqlDriver>;
  };

  const driver = await module.createSqlDriver();
  console.log(`[db] 驱动就绪：${driver.name} (${driver.target})`);
  return driver;
}

/** 返回当前驱动的名称与目标描述，供 `/health` 与日志使用。 */
export async function describeDriver(): Promise<{
  driver: DriverName;
  target: string;
}> {
  const driver = await getDriver();
  return { driver: driver.name, target: driver.target };
}

/** 关闭驱动并释放连接 / 文件句柄（进程退出或测试收尾时使用）。 */
export async function closeDriver(): Promise<void> {
  if (!driverPromise) return;
  const driver = await driverPromise;
  driverPromise = null;
  await driver.sql.end();
}

// ---------------------------------------------------------------------------
// 统一的 SQL 标签
// ---------------------------------------------------------------------------

/**
 * 路由层使用的 SQL 模板标签。
 *
 * 用法与 postgres.js 完全一致，内部转发给当前驱动：
 *
 * ```ts
 * const rows = await sql`SELECT id FROM badges WHERE id > ${lastId}`;
 * await sql.begin(async (tx) => {
 *   await tx`DELETE FROM issue_builds WHERE issue_id = ${issueId}`;
 * });
 * ```
 */
export const sql: SqlTag = Object.assign(
  async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> => {
    const driver = await getDriver();
    return await driver.sql(strings, ...values);
  },
  {
    begin: async <T>(callback: (tx: SqlTag) => Promise<T>): Promise<T> => {
      const driver = await getDriver();
      return await driver.sql.begin(callback);
    },
    end: async (options?: { timeout?: number }): Promise<void> => {
      await closeDriver();
      void options;
    },
  },
) as SqlTag;

// ---------------------------------------------------------------------------
// 公共辅助函数
// ---------------------------------------------------------------------------

/**
 * 按名称查找项目，不存在则创建，返回其 id。
 *
 * 两个驱动都支持 `ON CONFLICT ... DO UPDATE ... RETURNING`（SQLite 需 3.35+，
 * `node:sqlite` 内置的是 3.5x，满足要求）。
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
