/**
 * API 端到端测试。
 *
 * 用真实链路跑一遍 UGS 客户端会调用的全部接口：真实的 Hono 应用、
 * 真实的 HTTP 服务、真实的 SQLite 文件（临时目录，测试结束即清理），
 * 不依赖任何外部服务。
 *
 * 测试的生命周期是被显式管理的：
 *   临时目录 → initDatabase() → createApp() → 跑用例 → closeDatabase() → 删目录
 */

import { assertEquals, assertExists } from "@std/assert";
import { closeDatabase, initDatabase } from "../src/db.ts";
import { createApp } from "../src/app.ts";

// ---------------------------------------------------------------------------
// 准备
// ---------------------------------------------------------------------------

const tempDir = await Deno.makeTempDir({ prefix: "ugs-api-test-" });
const dbPath = `${tempDir}/ugs.db`;

initDatabase({ path: dbPath });
const app = createApp();

/** 模拟 UGS 客户端使用的 Perforce 路径。 */
const PROJECT = "//depot/main";
const PROJECT_QS = encodeURIComponent(PROJECT);

type JsonBody = Record<string, unknown> | unknown[] | null;

/** 发一个 GET 请求并返回解析后的 JSON。 */
async function getJson(path: string): Promise<JsonBody> {
  const response = await app.request(path);
  assertEquals(response.status, 200, `GET ${path} 返回了 ${response.status}`);
  return (await response.json()) as JsonBody;
}

/** 发一个带 JSON body 的请求。 */
async function send(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 发一个带 JSON body 的请求并断言 200。 */
async function sendOk(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await send(method, path, body);
  assertEquals(
    response.status,
    200,
    `${method} ${path} 返回了 ${response.status}`,
  );
  return response;
}

/** 把响应体断言成数组。 */
function asArray(body: JsonBody): Record<string, unknown>[] {
  assertEquals(Array.isArray(body), true, "期望返回数组");
  return body as Record<string, unknown>[];
}

/** 把响应体断言成对象。 */
function asObject(body: JsonBody): Record<string, unknown> {
  assertEquals(
    body !== null && !Array.isArray(body) && typeof body === "object",
    true,
    "期望返回对象",
  );
  return body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 端到端流程
// ---------------------------------------------------------------------------

Deno.test("API 端到端：完整流程", async (t) => {
  await t.step("数据库已在指定路径创建（目录由 openDatabase 自动建立）", async () => {
    const stat = await Deno.stat(dbPath);
    assertEquals(stat.isFile, true);

    // 建表脚本已执行：至少 projects / badges / issues 三张核心表存在
    const response = await app.request(`/api/latest?Project=${PROJECT_QS}`);
    assertEquals(response.status, 200);
  });

  // -------------------------------------------------------------------------
  await t.step("GET /api/latest 空库返回全 0", async () => {
    assertEquals(await getJson(`/api/latest?Project=${PROJECT_QS}`), {
      LastEventId: 0,
      LastCommentId: 0,
      LastBuildId: 0,
    });
  });

  await t.step("缺少必需参数时返回空数组而不是报错", async () => {
    assertEquals(await getJson("/api/build"), []);
    assertEquals(await getJson("/api/comment"), []);
    assertEquals(await getJson("/api/event"), []);
  });

  // -------------------------------------------------------------------------
  // 构建（badges）
  // -------------------------------------------------------------------------
  await t.step("POST /api/build 提交构建结果", async () => {
    await sendOk("POST", "/api/build", {
      Project: PROJECT,
      ChangeNumber: 100,
      BuildType: "Editor",
      Result: 3, // Success
      Url: "http://ci.example.com/100",
      ArchivePath: "//archive/100",
      Metadata: {
        Links: [{ Title: "日志", Url: "http://ci.example.com/100/log" }],
      },
    });

    // 字符串形式的枚举也要能接受（原始服务同样兼容）
    await sendOk("POST", "/api/build", {
      Project: PROJECT,
      ChangeNumber: 101,
      BuildType: "Editor",
      Result: "Failure",
      Url: "http://ci.example.com/101",
    });
  });

  await t.step("GET /api/build 返回增量数据且字段形状正确", async () => {
    const builds = asArray(
      await getJson(`/api/build?Project=${PROJECT_QS}&LastBuildId=0`),
    );
    assertEquals(builds.length, 2);

    assertEquals(builds[0], {
      Id: 1,
      ChangeNumber: 100,
      BuildType: "Editor",
      Result: 3,
      Url: "http://ci.example.com/100",
      Project: PROJECT,
      ArchivePath: "//archive/100",
      // Metadata 必须是对象（库里存的是 JSON 文本）
      Metadata: {
        Links: [{ Title: "日志", Url: "http://ci.example.com/100/log" }],
      },
      IsSuccess: true,
      IsFailure: false,
    });

    assertEquals(builds[1].Result, 1);
    assertEquals(builds[1].IsSuccess, false);
    assertEquals(builds[1].IsFailure, true);
    // 未提供 Metadata 时使用默认值
    assertEquals(builds[1].Metadata, { Links: [] });
    assertEquals(builds[1].ArchivePath, null);
  });

  await t.step("GET /api/build 支持 LastBuildId 增量拉取", async () => {
    const builds = asArray(
      await getJson(`/api/build?Project=${PROJECT_QS}&LastBuildId=1`),
    );
    assertEquals(builds.length, 1);
    assertEquals(builds[0].Id, 2);
  });

  await t.step("GET /api/build 对其他项目名返回空数组", async () => {
    const other = encodeURIComponent("//depot/other");
    assertEquals(await getJson(`/api/build?Project=${other}&LastBuildId=0`), []);
  });

  await t.step("GET /api/latest 反映最新构建的同步起点", async () => {
    // 注意语义：LastBuildId 不是「最大 id」，而是「最近 100 个 changelist 中
    // 最早那一条的 id」——UGS 客户端需要的是一个能覆盖最近改动量的增量起点。
    // 两个构建分属 change 100 / 101，因此起点是 change 100 对应的 id 1。
    const latest = asObject(await getJson(`/api/latest?Project=${PROJECT_QS}`));
    assertEquals(latest.LastBuildId, 1);
  });

  // -------------------------------------------------------------------------
  // 评审事件（user_votes）
  // -------------------------------------------------------------------------
  await t.step("POST /api/event 提交评审并读回", async () => {
    await sendOk("POST", "/api/event", {
      Project: PROJECT,
      Change: 100,
      UserName: "alice",
      Type: 3, // Good
    });
    await sendOk("POST", "/api/event", {
      Project: PROJECT,
      Change: 100,
      UserName: "bob",
      Type: "Bad",
    });

    const events = asArray(
      await getJson(`/api/event?Project=${PROJECT_QS}&LastEventId=0`),
    );
    assertEquals(events.length, 2);
    assertEquals(events[0], {
      Id: 1,
      Change: 100,
      UserName: "alice",
      Type: 3,
      Project: PROJECT,
    });
    assertEquals(events[1].Type, 4); // Bad
  });

  await t.step("GET /api/latest 反映最新事件 ID", async () => {
    const latest = asObject(await getJson(`/api/latest?Project=${PROJECT_QS}`));
    assertEquals(latest.LastEventId, 1);
  });

  // -------------------------------------------------------------------------
  // 评论（comments）
  // -------------------------------------------------------------------------
  await t.step("POST /api/comment 发表评论并读回", async () => {
    await sendOk("POST", "/api/comment", {
      Project: PROJECT,
      ChangeNumber: 100,
      UserName: "alice",
      Text: "这里有个编译警告",
    });

    const comments = asArray(
      await getJson(`/api/comment?Project=${PROJECT_QS}&LastCommentId=0`),
    );
    assertEquals(comments.length, 1);
    assertEquals(comments[0], {
      Id: 1,
      ChangeNumber: 100,
      UserName: "alice",
      Text: "这里有个编译警告",
      Project: PROJECT,
    });
  });

  // -------------------------------------------------------------------------
  // 遥测与错误上报
  // -------------------------------------------------------------------------
  await t.step("POST /api/telemetry 记录计时遥测", async () => {
    await sendOk("POST", "/api/telemetry?Version=1.2.3&IpAddress=10.0.0.1", {
      Action: "Sync",
      Result: "Ok",
      UserName: "alice",
      Project: PROJECT,
      Timestamp: "2026-01-02T03:04:05.678Z",
      Duration: 12.5,
    });
  });

  await t.step("POST /api/error + GET /api/error 往返一致", async () => {
    await sendOk("POST", "/api/error?Version=1.2.3&IpAddress=10.0.0.1", {
      Type: 0, // Crash
      Text: "boom",
      UserName: "alice",
      Project: PROJECT,
      Timestamp: "2026-01-02T03:04:05.678Z",
    });

    const errors = asArray(await getJson("/api/error?Records=10"));
    assertEquals(errors.length, 1);
    assertEquals(errors[0].Id, 1);
    assertEquals(errors[0].Type, 0);
    assertEquals(errors[0].Text, "boom");
    assertEquals(errors[0].UserName, "alice");
    assertEquals(errors[0].Project, PROJECT);
    assertEquals(errors[0].Version, "1.2.3");
    assertEquals(errors[0].IpAddress, "10.0.0.1");
    assertExists(errors[0].Timestamp);
  });

  await t.step("GET /api/error?Records=N 限制返回条数", async () => {
    await sendOk("POST", "/api/error?Version=1.2.3&IpAddress=10.0.0.2", {
      Type: "Crash",
      Text: "second",
      UserName: "bob",
      Project: PROJECT,
      Timestamp: "2026-01-02T04:00:00.000Z",
    });

    const all = asArray(await getJson("/api/error?Records=10"));
    assertEquals(all.length, 2);
    // 按 id 倒序，最新的在前
    assertEquals(all[0].Text, "second");

    const limited = asArray(await getJson("/api/error?Records=1"));
    assertEquals(limited.length, 1);
  });

  // -------------------------------------------------------------------------
  // 用户
  // -------------------------------------------------------------------------
  await t.step("GET /api/user 查找或创建用户（名字大小写无关）", async () => {
    const first = asObject(await getJson("/api/user?Name=alice"));
    assertExists(first.Id);
    assertEquals(await getJson("/api/user?Name=ALICE"), first);
    assertEquals(await getJson("/api/user?Name=Alice"), first);
  });

  await t.step("GET /api/user 缺少 Name 时返回 400", async () => {
    const response = await app.request("/api/user");
    assertEquals(response.status, 400);
  });

  // -------------------------------------------------------------------------
  // Issue 跟踪
  // -------------------------------------------------------------------------
  await t.step("POST /api/issues 创建 issue", async () => {
    const created = asObject(
      await sendOk("POST", "/api/issues", {
        Project: PROJECT,
        Summary: "Editor 构建失败",
        Owner: "alice",
      }).then((r) => r.json()),
    );
    assertEquals(created.Id, 1);
  });

  await t.step("GET /api/issues 列出未解决的 issue", async () => {
    const issues = asArray(await getJson("/api/issues"));
    assertEquals(issues.length, 1);
    assertEquals(issues[0].Id, 1);
    assertEquals(issues[0].Project, PROJECT);
    assertEquals(issues[0].Summary, "Editor 构建失败");
    // 用户名统一大写存储
    assertEquals(issues[0].Owner, "ALICE");
    assertEquals(issues[0].NominatedBy, null);
    assertEquals(issues[0].AcknowledgedAt, null);
    assertEquals(issues[0].FixChange, 0);
    assertEquals(issues[0].ResolvedAt, null);
    // 未指定 User 查询时不计算 bNotify
    assertEquals(issues[0].bNotify, false);
    assertExists(issues[0].CreatedAt);
    assertExists(issues[0].RetrievedAt);
  });

  await t.step("GET /api/issues/:id 返回单条 issue", async () => {
    const issue = asObject(await getJson("/api/issues/1"));
    assertEquals(issue.Id, 1);
    assertEquals(issue.Summary, "Editor 构建失败");
  });

  await t.step("GET /api/issues/:id 不存在时返回 404", async () => {
    const response = await app.request("/api/issues/9999");
    assertEquals(response.status, 404);
    assertEquals(await response.json(), null);
  });

  await t.step("PUT /api/issues/:id 更新字段（含布尔与时间戳条件更新）", async () => {
    await sendOk("PUT", "/api/issues/1", {
      Summary: "Editor 构建失败（已定位）",
      NominatedBy: "bob",
      Acknowledged: true,
      FixChange: 1234,
    });

    const issue = asObject(await getJson("/api/issues/1"));
    assertEquals(issue.Summary, "Editor 构建失败（已定位）");
    assertEquals(issue.NominatedBy, "BOB");
    assertEquals(issue.FixChange, 1234);
    assertExists(issue.AcknowledgedAt);
    assertEquals(issue.ResolvedAt, null);
    // 未传的字段保持原值
    assertEquals(issue.Owner, "ALICE");
  });

  await t.step("PUT /api/issues/:id 可以取消 Acknowledged", async () => {
    await sendOk("PUT", "/api/issues/1", { Acknowledged: false });
    const issue = asObject(await getJson("/api/issues/1"));
    assertEquals(issue.AcknowledgedAt, null);
  });

  // ---- 子资源：构建 ----
  await t.step("POST /api/issues/:id/builds 创建 issue 构建", async () => {
    const created = asObject(
      await sendOk("POST", "/api/issues/1/builds", {
        Stream: "//depot/main",
        Change: 100,
        JobName: "Editor-Win64",
        JobUrl: "http://ci.example.com/job/1",
        JobStepName: "Build",
        Outcome: 0,
      }).then((r) => r.json()),
    );
    assertEquals(created.Id, 1);
  });

  await t.step("GET /api/issues/:id/builds 返回构建列表", async () => {
    const builds = asArray(await getJson("/api/issues/1/builds"));
    assertEquals(builds.length, 1);
    assertEquals(builds[0], {
      Id: 1,
      Stream: "//depot/main",
      Change: 100,
      JobName: "Editor-Win64",
      JobUrl: "http://ci.example.com/job/1",
      JobStepName: "Build",
      JobStepUrl: null,
      ErrorUrl: null,
      Outcome: 0,
    });
  });

  await t.step("GET /api/issuebuilds/:id 与 PUT 修改 outcome", async () => {
    const build = asObject(await getJson("/api/issuebuilds/1"));
    assertEquals(build.Outcome, 0);

    await sendOk("PUT", "/api/issuebuilds/1", { Outcome: 1 });
    const updated = asObject(await getJson("/api/issuebuilds/1"));
    assertEquals(updated.Outcome, 1);
  });

  await t.step("GET /api/issuebuilds/:id 不存在时返回 404", async () => {
    const response = await app.request("/api/issuebuilds/9999");
    assertEquals(response.status, 404);
  });

  // ---- 子资源：诊断信息 ----
  await t.step("POST/GET /api/issues/:id/diagnostics 往返一致", async () => {
    await sendOk("POST", "/api/issues/1/diagnostics", {
      BuildId: 1,
      Message: "编译错误：未定义的符号",
      Url: "http://ci.example.com/job/1/error",
    });

    const diagnostics = asArray(await getJson("/api/issues/1/diagnostics"));
    assertEquals(diagnostics.length, 1);
    assertEquals(diagnostics[0], {
      BuildId: 1,
      Message: "编译错误：未定义的符号",
      Url: "http://ci.example.com/job/1/error",
    });
  });

  // ---- 子资源：关注者 ----
  await t.step("watchers 增删查与 bNotify", async () => {
    await sendOk("POST", "/api/issues/1/watchers", { UserName: "bob" });
    // 重复添加不应报错（ON CONFLICT DO NOTHING）
    await sendOk("POST", "/api/issues/1/watchers", { UserName: "bob" });
    assertEquals(await getJson("/api/issues/1/watchers"), ["BOB"]);

    // 指定 User 查询时 bNotify 为 true
    const watched = asArray(await getJson("/api/issues?User=bob"));
    assertEquals(watched.length, 1);
    assertEquals(watched[0].bNotify, true);

    // 非关注者 bNotify 为 false
    const notWatched = asArray(await getJson("/api/issues?User=alice"));
    assertEquals(notWatched.length, 1);
    assertEquals(notWatched[0].bNotify, false);

    await sendOk("DELETE", "/api/issues/1/watchers", { UserName: "bob" });
    assertEquals(await getJson("/api/issues/1/watchers"), []);
  });

  // ---- 解决 / 列表过滤 ----
  await t.step("PUT 标记 Resolved 后默认列表不再返回该 issue", async () => {
    await sendOk("PUT", "/api/issues/1", { Resolved: true });

    assertEquals(await getJson("/api/issues"), []);
    assertEquals(await getJson("/api/issues?User=alice"), []);

    const resolved = asArray(
      await getJson("/api/issues?IncludeResolved=true&MaxResults=10"),
    );
    assertEquals(resolved.length, 1);
    assertExists(resolved[0].ResolvedAt);

    // 取消解决
    await sendOk("PUT", "/api/issues/1", { Resolved: false });
    assertEquals(asArray(await getJson("/api/issues")).length, 1);
  });

  // ---- 级联删除 ----
  await t.step("DELETE /api/issues/:id 级联删除子资源", async () => {
    await sendOk("DELETE", "/api/issues/1");

    const response = await app.request("/api/issues/1");
    assertEquals(response.status, 404);
    assertEquals(await getJson("/api/issues/1/builds"), []);
    assertEquals(await getJson("/api/issues/1/diagnostics"), []);
    assertEquals(await getJson("/api/issues/1/watchers"), []);
    assertEquals(asArray(await getJson("/api/issues")), []);
  });

  // -------------------------------------------------------------------------
  // 旧版 CIS 接口
  // -------------------------------------------------------------------------
  await t.step(
    "GET /api/cis 返回 [LastEventId, LastCommentId, LastBuildId]",
    async () => {
      // 与 /api/latest 同语义：都是最近 100 个 changelist 的增量同步起点
      assertEquals(await getJson(`/api/cis?Project=${PROJECT_QS}`), [1, 1, 1]);
    },
  );

  await t.step("GET /api/cis 带 LastBuildId 时等价于 /api/build", async () => {
    const builds = asArray(
      await getJson(`/api/cis?Project=${PROJECT_QS}&LastBuildId=0`),
    );
    assertEquals(builds.length, 2);
    assertEquals(builds[0].Id, 1);
  });

  await t.step("POST /api/cis 等价于 POST /api/build", async () => {
    await sendOk("POST", "/api/cis", {
      Project: PROJECT,
      ChangeNumber: 102,
      BuildType: "Editor",
      Result: 3,
      Url: "http://ci.example.com/102",
    });
    const builds = asArray(
      await getJson(`/api/build?Project=${PROJECT_QS}&LastBuildId=2`),
    );
    assertEquals(builds.length, 1);
    assertEquals(builds[0].ChangeNumber, 102);
  });

  // -------------------------------------------------------------------------
  // 真实 HTTP 链路 + /health（Docker healthcheck 依赖）
  // -------------------------------------------------------------------------
  await t.step("Deno.serve 真实 HTTP 链路与 /health", async () => {
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, app.fetch);
    const base = `http://127.0.0.1:${server.addr.port}`;

    try {
      const health = await fetch(`${base}/health`);
      assertEquals(health.status, 200);
      const healthBody = asObject((await health.json()) as JsonBody);
      assertEquals(healthBody.status, "ok");
      assertEquals(healthBody.database, dbPath);

      const root = await fetch(`${base}/`);
      assertEquals(root.status, 200);
      assertEquals(
        (await root.json()) as JsonBody,
        { status: "ok", service: "UGS Metadata Server" },
      );

      const latest =
        (await (await fetch(`${base}/api/latest`)).json()) as JsonBody;
      assertExists(asObject(latest).LastBuildId);
    } finally {
      await server.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// 收尾：关闭数据库并清理临时目录
// ---------------------------------------------------------------------------

Deno.test("收尾：关闭数据库并清理临时数据", async () => {
  closeDatabase();
  await Deno.remove(tempDir, { recursive: true });
});
