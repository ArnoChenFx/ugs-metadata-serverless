/**
 * 极简 `.env` 解析器。
 *
 * 为什么不用 `Deno.loadEnvFile()` / `--env-file`：
 *   - `Deno.loadEnvFile` 在当前 Deno 版本中尚未提供；
 *   - `--env-file=.env` 在文件缺失时虽然只是警告，但行为不完全可控，
 *     而且需要写进每一条启动命令里。
 *
 * 自己实现的好处是：本地 `deno task start`、Docker（环境变量由 compose 注入）、
 * 单元测试三种场景都能用同一套逻辑，且**不覆盖**已存在的真实环境变量
 * （即「进程环境变量 > .env 文件」）。
 */

/** Windows / Unix 通用的换行与注释处理。 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 `.env` 文本内容。
 *
 * 支持：
 *   - `KEY=value` / `KEY = value`
 *   - `export KEY=value`（shell 风格）
 *   - `#` 开头的整行注释与行尾注释（未加引号时）
 *   - 单引号（原样）、双引号（解析 `\n` `\r` `\t` `\\` `\"` 转义）
 *
 * 不支持多行值（本项目用不到）。
 */
export function parseDotEnv(text: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;

    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\([nrt\\"])/g, (_match, code: string) => {
          switch (code) {
            case "n":
              return "\n";
            case "r":
              return "\r";
            case "t":
              return "\t";
            default:
              return code;
          }
        });
    } else if (
      value.startsWith("'") && value.endsWith("'") && value.length >= 2
    ) {
      // 单引号内不做转义处理
      value = value.slice(1, -1);
    } else {
      // 未加引号时，去掉行尾注释
      const commentAt = value.indexOf(" #");
      if (commentAt >= 0) value = value.slice(0, commentAt).trim();
    }

    result.set(key, value);
  }

  return result;
}

/** `.env` 加载选项。 */
export interface LoadDotEnvOptions {
  /** 文件路径，默认 `.env`（相对进程工作目录）。 */
  path?: string;
  /** 是否覆盖已存在的环境变量，默认 false（真实环境变量优先）。 */
  override?: boolean;
  /** 是否打印加载日志，默认 false。 */
  verbose?: boolean;
}

/**
 * 从 `.env` 文件加载环境变量到进程环境。
 *
 * 文件不存在时静默返回（Docker 场景下环境变量由 compose 提供，没有 .env 是正常的）。
 * 返回实际加载的键数量，方便调用方打日志。
 */
export function loadDotEnv(options: LoadDotEnvOptions = {}): number {
  const path = options.path ?? ".env";

  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const [key, value] of parseDotEnv(text)) {
    if (!options.override && Deno.env.get(key) !== undefined) continue;
    Deno.env.set(key, value);
    loaded++;
  }

  if (options.verbose && loaded > 0) {
    console.log(`[env] 已从 ${path} 加载 ${loaded} 个环境变量`);
  }

  return loaded;
}
