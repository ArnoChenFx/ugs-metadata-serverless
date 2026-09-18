import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";
import {
  query,
  projectLikeString,
  matchesWildcard,
  parseJsonColumn,
  BuildDataResult,
} from "../utils.ts";

/**
 * CIS controller - DEPRECATED, kept for backward compatibility.
 * Proxies to Build and Latest functionality.
 */
export const cisRoutes = new Hono();

// GET /api/cis?Project=...  (returns latest IDs as array)
// GET /api/cis?Project=...&LastBuildId=...  (returns builds)
cisRoutes.get("/", async (c) => {
  const project = query(c, "Project") ?? null;
  const lastBuildId = query(c, "LastBuildId");

  if (lastBuildId != null) {
    // Same as GET /api/build
    const like = projectLikeString(project);
    const rows = await sql`
      SELECT b.id, b.change_number, b.build_type, b.result, b.url,
             p.name AS project, b.archive_path, b.metadata
      FROM badges b
      INNER JOIN projects p ON p.id = b.project_id
      WHERE b.id > ${Number(lastBuildId)} AND p.name LIKE ${like}
      ORDER BY b.id
    `;

    const builds = rows
      .filter((r) => {
        const p = r.project as string | null;
        return (
          p == null ||
          (project != null && p.toLowerCase() === project.toLowerCase()) ||
          (project != null && matchesWildcard(p, project))
        );
      })
      .map((r) => {
        const resultStr = (r.result as string).trim();
        const resultInt = BuildDataResult[resultStr] ?? 0;
        return {
          Id: Number(r.id),
          ChangeNumber: r.change_number as number,
          BuildType: (r.build_type as string).trim(),
          Result: resultInt,
          Url: r.url as string,
          Project: r.project as string | null,
          ArchivePath: r.archive_path as string | null,
          // jsonb（Postgres）与 TEXT（SQLite）统一成对象
          Metadata: parseJsonColumn(r.metadata),
          IsSuccess: resultInt === BuildDataResult.Success || resultInt === BuildDataResult.Warning,
          IsFailure: resultInt === BuildDataResult.Failure,
        };
      });

    return c.json(builds);
  }

  // Return latest IDs as array [LastEventId, LastCommentId, LastBuildId]
  const like = projectLikeString(project);

  let lastEventId = 0;
  let lastCommentId = 0;
  let lastBuildIdResult = 0;

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
  if (eventRows.length > 0) lastEventId = Number(eventRows[0].id);

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
  if (commentRows.length > 0) lastCommentId = Number(commentRows[0].id);

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
  if (buildRows.length > 0) lastBuildIdResult = Number(buildRows[0].id);

  // CIS returns as a plain array, not an object
  return c.json([lastEventId, lastCommentId, lastBuildIdResult]);
});

// POST /api/cis  (same as POST /api/build)
cisRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const projectId = await getOrCreateProjectId(body.Project);

  const resultStr =
    typeof body.Result === "number"
      ? Object.entries(BuildDataResult).find(([, v]) => v === body.Result)?.[0] ?? "Starting"
      : String(body.Result);

  await sql`
    INSERT INTO badges (change_number, build_type, result, url, archive_path, project_id, metadata)
    VALUES (
      ${body.ChangeNumber},
      ${body.BuildType},
      ${resultStr},
      ${body.Url},
      ${body.ArchivePath ?? null},
      ${projectId},
      ${JSON.stringify(body.Metadata ?? { Links: [] })}::jsonb
    )
  `;

  return c.body(null, 200);
});
