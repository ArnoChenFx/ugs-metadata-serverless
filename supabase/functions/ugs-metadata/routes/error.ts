import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";
import { query, TelemetryErrorType, TelemetryErrorTypeFromInt } from "../utils.ts";

export const errorRoutes = new Hono();

// GET /api/error?Records=10
errorRoutes.get("/", async (c) => {
  const records = Number(query(c, "Records") ?? "10");

  const rows = await sql`
    SELECT id, type, text, user_name, project, "timestamp", version, ip_address
    FROM errors
    ORDER BY id DESC
    LIMIT ${records}
  `;

  const errors = rows.map((r) => ({
    Id: Number(r.id),
    Type: TelemetryErrorType[(r.type as string)] ?? 0,
    Text: r.text as string,
    UserName: r.user_name as string,
    Project: r.project as string | null,
    Timestamp: r.timestamp as string,
    Version: r.version as string,
    IpAddress: r.ip_address as string,
  }));

  return c.json(errors);
});

// POST /api/error?Version=...&IpAddress=...
errorRoutes.post("/", async (c) => {
  const version = query(c, "Version") ?? "";
  const ipAddress = query(c, "IpAddress") ?? "";
  const body = await c.req.json();

  const typeStr =
    typeof body.Type === "number"
      ? TelemetryErrorTypeFromInt[body.Type] ?? "Crash"
      : String(body.Type);

  let projectId: number | null = null;
  if (body.Project) {
    projectId = await getOrCreateProjectId(body.Project);
  }

  // Truncate error text to 1024 chars
  const text = body.Text ? body.Text.substring(0, 1024) : "";

  await sql`
    INSERT INTO errors (type, text, user_name, project, "timestamp", version, ip_address, project_id)
    VALUES (
      ${typeStr},
      ${text},
      ${body.UserName},
      ${body.Project ?? null},
      ${body.Timestamp},
      ${version},
      ${ipAddress},
      ${projectId}
    )
  `;

  return c.body(null, 200);
});
