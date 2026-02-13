import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";

export const telemetryRoutes = new Hono();

// POST /api/telemetry?Version=...&IpAddress=...
telemetryRoutes.post("/", async (c) => {
  const version = c.req.query("Version") ?? "";
  const ipAddress = c.req.query("IpAddress") ?? "";
  const body = await c.req.json();

  const projectId = await getOrCreateProjectId(body.Project);

  await sql`
    INSERT INTO telemetry_v2 (action, result, user_name, project, "timestamp", duration, version, ip_address, project_id)
    VALUES (
      ${body.Action},
      ${body.Result},
      ${body.UserName},
      ${body.Project},
      ${body.Timestamp},
      ${body.Duration},
      ${version},
      ${ipAddress},
      ${projectId}
    )
  `;

  return c.body(null, 200);
});
