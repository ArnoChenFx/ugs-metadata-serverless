import { Hono } from "hono";
import { sql } from "../db.ts";
import { query, projectLikeString } from "../utils.ts";

export const latestRoutes = new Hono();

// GET /api/latest?Project=...
latestRoutes.get("/", async (c) => {
  const project = query(c, "Project") ?? null;
  const like = projectLikeString(project);

  let lastEventId = 0;
  let lastCommentId = 0;
  let lastBuildId = 0;

  // Get the oldest ID among the last 100 unique changelists for events
  const eventRows = await sql`
    WITH votes AS (
      SELECT MIN(uv.id) AS id, uv.changelist
      FROM user_votes uv
      INNER JOIN projects p ON p.id = uv.project_id
      WHERE p.name LIKE ${like}
      GROUP BY uv.changelist
      ORDER BY uv.changelist DESC
      LIMIT 100
    )
    SELECT id FROM votes ORDER BY changelist ASC LIMIT 1
  `;
  if (eventRows.length > 0) {
    lastEventId = Number(eventRows[0].id);
  }

  // Same for comments
  const commentRows = await sql`
    WITH cmts AS (
      SELECT MIN(c.id) AS id, c.change_number
      FROM comments c
      INNER JOIN projects p ON p.id = c.project_id
      WHERE p.name LIKE ${like}
      GROUP BY c.change_number
      ORDER BY c.change_number DESC
      LIMIT 100
    )
    SELECT id FROM cmts ORDER BY change_number ASC LIMIT 1
  `;
  if (commentRows.length > 0) {
    lastCommentId = Number(commentRows[0].id);
  }

  // Same for badges/builds
  const buildRows = await sql`
    WITH bdg AS (
      SELECT MIN(b.id) AS id, b.change_number
      FROM badges b
      INNER JOIN projects p ON p.id = b.project_id
      WHERE p.name LIKE ${like}
      GROUP BY b.change_number
      ORDER BY b.change_number DESC
      LIMIT 100
    )
    SELECT id FROM bdg ORDER BY change_number ASC LIMIT 1
  `;
  if (buildRows.length > 0) {
    lastBuildId = Number(buildRows[0].id);
  }

  return c.json({
    LastEventId: lastEventId,
    LastCommentId: lastCommentId,
    LastBuildId: lastBuildId,
  });
});
