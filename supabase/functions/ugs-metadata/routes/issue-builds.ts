import { Hono } from "hono";
import { sql } from "../db.ts";

export const issueBuildsRoutes = new Hono();

// GET /api/issuebuilds/:buildId
issueBuildsRoutes.get("/:buildId", async (c) => {
  const buildId = Number(c.req.param("buildId"));

  const rows = await sql`
    SELECT id, stream, change, job_name, job_url, job_step_name, job_step_url, error_url, outcome
    FROM issue_builds
    WHERE id = ${buildId}
  `;

  if (rows.length === 0) {
    return c.json(null, 404);
  }

  const r = rows[0];
  return c.json({
    Id: Number(r.id),
    Stream: r.stream as string,
    Change: r.change as number,
    JobName: r.job_name as string,
    JobUrl: r.job_url as string,
    JobStepName: r.job_step_name as string | null,
    JobStepUrl: r.job_step_url as string | null,
    ErrorUrl: r.error_url as string | null,
    Outcome: r.outcome as number,
  });
});

// PUT /api/issuebuilds/:buildId
issueBuildsRoutes.put("/:buildId", async (c) => {
  const buildId = Number(c.req.param("buildId"));
  const body = await c.req.json();

  await sql`
    UPDATE issue_builds SET outcome = ${body.Outcome} WHERE id = ${buildId}
  `;

  return c.body(null, 200);
});
