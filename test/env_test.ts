/**
 * `.env` 解析器单元测试。
 */

import { assertEquals } from "@std/assert";
import { parseDotEnv } from "../supabase/functions/ugs-metadata/env.ts";

Deno.test("parseDotEnv: 基础键值对与空行/注释", () => {
  const parsed = parseDotEnv(`
# 这是一行注释

DB_DRIVER=sqlite
PORT = 8080

  # 缩进的注释同样被忽略
SQLITE_PATH=./data/ugs.db
`);

  assertEquals(parsed.get("DB_DRIVER"), "sqlite");
  assertEquals(parsed.get("PORT"), "8080");
  assertEquals(parsed.get("SQLITE_PATH"), "./data/ugs.db");
  assertEquals(parsed.size, 3);
});

Deno.test("parseDotEnv: export 前缀与行尾注释", () => {
  const parsed = parseDotEnv(`
export DB_DRIVER=postgres
PORT=8080 # 行尾注释
`);

  assertEquals(parsed.get("DB_DRIVER"), "postgres");
  assertEquals(parsed.get("PORT"), "8080");
});

Deno.test("parseDotEnv: 引号与转义", () => {
  const parsed = parseDotEnv(String.raw`
DOUBLE="hello world"
SINGLE='literal # not a comment'
ESCAPED="line1\nline2"
MULTILINE="say \"hi\""
`);

  assertEquals(parsed.get("DOUBLE"), "hello world");
  // 单引号内不处理转义，且行尾注释规则不生效
  assertEquals(parsed.get("SINGLE"), "literal # not a comment");
  assertEquals(parsed.get("ESCAPED"), "line1\nline2");
  assertEquals(parsed.get("MULTILINE"), 'say "hi"');
});

Deno.test("parseDotEnv: 忽略非法行", () => {
  const parsed = parseDotEnv(`
=没有键
NO_EQUALS_SIGN
1INVALID=value
VALID=ok
`);

  assertEquals(parsed.size, 1);
  assertEquals(parsed.get("VALID"), "ok");
});

Deno.test("parseDotEnv: CRLF 换行（Windows 上编辑过的文件）", () => {
  const parsed = parseDotEnv("A=1\r\nB=2\r\n");
  assertEquals(parsed.get("A"), "1");
  assertEquals(parsed.get("B"), "2");
});
