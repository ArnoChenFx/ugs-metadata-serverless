/**
 * Supabase Edge Function 入口。
 *
 * 这是云端 serverless 部署路径（`supabase functions deploy ugs-metadata`）。
 * Supabase 会把函数名拼进 URL，因此这里带上 `/ugs-metadata` 前缀：
 *
 *   https://<project-ref>.supabase.co/functions/v1/ugs-metadata/api/latest
 *
 * 纯本地运行请使用同目录下的 `serve.ts`（无前缀）。
 */

import { createApp } from "./app.ts";

const app = createApp({ basePath: "/ugs-metadata" });

Deno.serve(app.fetch);
