import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";
import {
  projectLikeString,
  matchesWildcard,
  BuildDataResult,
} from "../utils.ts";

export const buildRoutes = new Hono();

// GET /api/build?Project=...&LastBuildId=...
buildRoutes.get("/", async (c) => {
  const project = c.req.query("Project");
  const lastBuildId = c.req.query("LastBuildId");
  if (!project || lastBuildId == null) {
    return c.json([], 200);
  }

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
        p.toLowerCase() === project.toLowerCase() ||
        matchesWildcard(p, project)
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
        Metadata: r.metadata ?? null,
        IsSuccess: resultInt === BuildDataResult.Success || resultInt === BuildDataResult.Warning,
        IsFailure: resultInt === BuildDataResult.Failure,
      };
    });

  return c.json(builds);
});

// POST /api/build
buildRoutes.post("/", async (c) => {
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
