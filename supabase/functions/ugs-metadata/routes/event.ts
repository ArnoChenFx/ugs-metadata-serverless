import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";
import { projectLikeString, EventType, EventTypeFromInt } from "../utils.ts";

export const eventRoutes = new Hono();

// GET /api/event?Project=...&LastEventId=...
eventRoutes.get("/", async (c) => {
  const project = c.req.query("Project");
  const lastEventId = c.req.query("LastEventId");
  if (!project || lastEventId == null) {
    return c.json([], 200);
  }

  const like = projectLikeString(project);
  const rows = await sql`
    SELECT uv.id, uv.changelist, uv.user_name, uv.verdict, uv.project
    FROM user_votes uv
    INNER JOIN projects p ON p.id = uv.project_id
    WHERE uv.id > ${Number(lastEventId)} AND p.name LIKE ${like}
    ORDER BY uv.id
  `;

  const events = rows
    .filter((r) => {
      const verdictStr = (r.verdict as string).trim();
      if (EventType[verdictStr] === undefined) return false;
      const p = r.project as string | null;
      return p == null || p.toLowerCase() === project.toLowerCase();
    })
    .map((r) => ({
      Id: Number(r.id),
      Change: r.changelist as number,
      UserName: r.user_name as string,
      Type: EventType[(r.verdict as string).trim()],
      Project: r.project as string | null,
    }));

  return c.json(events);
});

// POST /api/event
eventRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const projectId = await getOrCreateProjectId(body.Project);

  // Accept both integer and string enum values
  const verdictStr =
    typeof body.Type === "number"
      ? EventTypeFromInt[body.Type] ?? "Unknown"
      : String(body.Type);

  await sql`
    INSERT INTO user_votes (changelist, user_name, verdict, project, project_id)
    VALUES (${body.Change}, ${body.UserName}, ${verdictStr}, ${body.Project}, ${projectId})
  `;

  return c.body(null, 200);
});
