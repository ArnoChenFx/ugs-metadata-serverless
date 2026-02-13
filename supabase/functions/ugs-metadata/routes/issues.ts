import { Hono } from "hono";
import { sql, findOrAddUserId } from "../db.ts";
import { sanitizeText } from "../utils.ts";

export const issuesRoutes = new Hono();

const ISSUE_SUMMARY_MAX_LENGTH = 200;

// ---------- Main issues CRUD ----------

// GET /api/issues  (list or by user)
// GET /api/issues?IncludeResolved=false&MaxResults=-1
// GET /api/issues?User=...
issuesRoutes.get("/", async (c) => {
  const user = c.req.query("User");

  if (user) {
    return await getIssuesByUser(c, user);
  }

  const includeResolved = c.req.query("IncludeResolved") === "true";
  const maxResults = Number(c.req.query("MaxResults") ?? "-1");

  return await getIssuesList(c, includeResolved, maxResults);
});

// GET /api/issues/:id
issuesRoutes.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const issues = await getIssuesInternal(id, null, true, -1);
  if (issues.length === 0) {
    return c.json(null, 404);
  }
  return c.json(issues[0]);
});

// POST /api/issues
issuesRoutes.post("/", async (c) => {
  const body = await c.req.json();

  let ownerId: number | null = null;
  if (body.Owner) {
    ownerId = await findOrAddUserId(body.Owner);
  }

  const summary = sanitizeText(body.Summary ?? "", ISSUE_SUMMARY_MAX_LENGTH);

  const [row] = await sql`
    INSERT INTO issues (project, summary, owner_id, created_at, fix_change)
    VALUES (${body.Project}, ${summary}, ${ownerId}, NOW() AT TIME ZONE 'utc', 0)
    RETURNING id
  `;

  return c.json({ Id: Number(row.id) });
});

// PUT /api/issues/:id
issuesRoutes.put("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  // Build dynamic SET clause
  const sets: string[] = [];
  const params: Record<string, unknown> = {};

  if (body.Summary != null) {
    const summary = sanitizeText(body.Summary, ISSUE_SUMMARY_MAX_LENGTH);
    sets.push("summary = ${summary}");
    params.summary = summary;
  }
  if (body.Owner != null) {
    const ownerId = await findOrAddUserId(body.Owner);
    sets.push("owner_id = ${ownerId}");
    params.ownerId = ownerId;
  }
  if (body.NominatedBy != null) {
    const nominatedById = await findOrAddUserId(body.NominatedBy);
    sets.push("nominated_by_id = ${nominatedById}");
    params.nominatedById = nominatedById;
  }
  if (body.Acknowledged != null) {
    // Use raw SQL approach for conditional timestamp
  }
  if (body.FixChange != null) {
    sets.push("fix_change = ${fixChange}");
    params.fixChange = body.FixChange;
  }
  if (body.Resolved != null) {
    // Use raw SQL approach for conditional timestamp
  }

  // Build and execute update using individual conditional updates
  // This handles the dynamic nature of the update more cleanly
  await sql`
    UPDATE issues SET
      summary = CASE WHEN ${body.Summary != null} THEN ${sanitizeText(body.Summary ?? "", ISSUE_SUMMARY_MAX_LENGTH)} ELSE summary END,
      owner_id = CASE WHEN ${body.Owner != null} THEN ${body.Owner ? await findOrAddUserId(body.Owner) : null} ELSE owner_id END,
      nominated_by_id = CASE WHEN ${body.NominatedBy != null} THEN ${body.NominatedBy ? await findOrAddUserId(body.NominatedBy) : null} ELSE nominated_by_id END,
      acknowledged_at = CASE
        WHEN ${body.Acknowledged === true} THEN NOW() AT TIME ZONE 'utc'
        WHEN ${body.Acknowledged === false} THEN NULL
        ELSE acknowledged_at END,
      fix_change = CASE WHEN ${body.FixChange != null} THEN ${body.FixChange ?? 0} ELSE fix_change END,
      resolved_at = CASE
        WHEN ${body.Resolved === true} THEN NOW() AT TIME ZONE 'utc'
        WHEN ${body.Resolved === false} THEN NULL
        ELSE resolved_at END
    WHERE id = ${id}
  `;

  return c.body(null, 200);
});

// DELETE /api/issues/:id
issuesRoutes.delete("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));

  // Cascade delete within a transaction
  await sql.begin(async (tx) => {
    await tx`DELETE FROM issue_watchers WHERE issue_id = ${id}`;
    await tx`DELETE FROM issue_diagnostics WHERE issue_id = ${id}`;
    await tx`DELETE FROM issue_builds WHERE issue_id = ${id}`;
    await tx`DELETE FROM issues WHERE id = ${id}`;
  });

  return c.body(null, 200);
});

// ---------- Sub-resources ----------

// GET /api/issues/:issueId/builds
issuesRoutes.get("/:issueId/builds", async (c) => {
  const issueId = Number(c.req.param("issueId"));

  const rows = await sql`
    SELECT id, stream, change, job_name, job_url, job_step_name, job_step_url, error_url, outcome
    FROM issue_builds
    WHERE issue_id = ${issueId}
  `;

  const builds = rows.map((r) => ({
    Id: Number(r.id),
    Stream: r.stream as string,
    Change: r.change as number,
    JobName: r.job_name as string,
    JobUrl: r.job_url as string,
    JobStepName: r.job_step_name as string | null,
    JobStepUrl: r.job_step_url as string | null,
    ErrorUrl: r.error_url as string | null,
    Outcome: r.outcome as number,
  }));

  return c.json(builds);
});

// POST /api/issues/:issueId/builds
issuesRoutes.post("/:issueId/builds", async (c) => {
  const issueId = Number(c.req.param("issueId"));
  const body = await c.req.json();

  const [row] = await sql`
    INSERT INTO issue_builds (issue_id, stream, change, job_name, job_url, job_step_name, job_step_url, error_url, outcome)
    VALUES (
      ${issueId},
      ${body.Stream},
      ${body.Change},
      ${body.JobName},
      ${body.JobUrl},
      ${body.JobStepName ?? null},
      ${body.JobStepUrl ?? null},
      ${body.ErrorUrl ?? null},
      ${body.Outcome}
    )
    RETURNING id
  `;

  return c.json({ Id: Number(row.id) });
});

// GET /api/issues/:issueId/diagnostics
issuesRoutes.get("/:issueId/diagnostics", async (c) => {
  const issueId = Number(c.req.param("issueId"));

  const rows = await sql`
    SELECT build_id, message, url
    FROM issue_diagnostics
    WHERE issue_id = ${issueId}
  `;

  const diagnostics = rows.map((r) => ({
    BuildId: r.build_id != null ? Number(r.build_id) : null,
    Message: r.message as string,
    Url: r.url as string | null,
  }));

  return c.json(diagnostics);
});

// POST /api/issues/:issueId/diagnostics
issuesRoutes.post("/:issueId/diagnostics", async (c) => {
  const issueId = Number(c.req.param("issueId"));
  const body = await c.req.json();

  const message = sanitizeText(body.Message ?? "", 1000);

  await sql`
    INSERT INTO issue_diagnostics (issue_id, build_id, message, url)
    VALUES (${issueId}, ${body.BuildId ?? null}, ${message}, ${body.Url ?? null})
  `;

  return c.body(null, 200);
});

// GET /api/issues/:issueId/watchers
issuesRoutes.get("/:issueId/watchers", async (c) => {
  const issueId = Number(c.req.param("issueId"));

  const rows = await sql`
    SELECT u.name
    FROM issue_watchers iw
    LEFT JOIN users u ON iw.user_id = u.id
    WHERE iw.issue_id = ${issueId}
  `;

  return c.json(rows.map((r) => r.name as string));
});

// POST /api/issues/:issueId/watchers
issuesRoutes.post("/:issueId/watchers", async (c) => {
  const issueId = Number(c.req.param("issueId"));
  const body = await c.req.json();

  const userId = await findOrAddUserId(body.UserName);

  await sql`
    INSERT INTO issue_watchers (issue_id, user_id)
    VALUES (${issueId}, ${userId})
    ON CONFLICT DO NOTHING
  `;

  return c.body(null, 200);
});

// DELETE /api/issues/:issueId/watchers
issuesRoutes.delete("/:issueId/watchers", async (c) => {
  const issueId = Number(c.req.param("issueId"));
  const body = await c.req.json();

  const userId = await findOrAddUserId(body.UserName);

  await sql`
    DELETE FROM issue_watchers WHERE issue_id = ${issueId} AND user_id = ${userId}
  `;

  return c.body(null, 200);
});

// ---------- Internal helpers ----------

async function getIssuesList(c: any, includeResolved: boolean, maxResults: number) {
  const issues = await getIssuesInternal(-1, null, includeResolved, maxResults);
  return c.json(issues);
}

async function getIssuesByUser(c: any, userName: string) {
  const issues = await getIssuesInternal(-1, userName, false, -1);
  return c.json(issues);
}

async function getIssuesInternal(
  issueId: number,
  userName: string | null,
  includeResolved: boolean,
  numResults: number
) {
  let userId = -1;
  if (userName != null) {
    userId = await findOrAddUserId(userName);
  }

  // Build the query dynamically based on parameters
  let rows;

  if (issueId !== -1) {
    // Single issue by ID
    if (userName != null) {
      rows = await sql`
        SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
               ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at,
               iw.user_id AS watcher_user_id
        FROM issues i
        LEFT JOIN users ou ON ou.id = i.owner_id
        LEFT JOIN users nu ON nu.id = i.nominated_by_id
        LEFT JOIN issue_watchers iw ON iw.issue_id = i.id AND iw.user_id = ${userId}
        WHERE i.id = ${issueId}
      `;
    } else {
      rows = await sql`
        SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
               ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at
        FROM issues i
        LEFT JOIN users ou ON ou.id = i.owner_id
        LEFT JOIN users nu ON nu.id = i.nominated_by_id
        WHERE i.id = ${issueId}
      `;
    }
  } else if (userName != null) {
    // Issues for a specific user (unresolved only, no limit)
    rows = await sql`
      SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
             ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at,
             iw.user_id AS watcher_user_id
      FROM issues i
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN users nu ON nu.id = i.nominated_by_id
      LEFT JOIN issue_watchers iw ON iw.issue_id = i.id AND iw.user_id = ${userId}
      WHERE i.resolved_at IS NULL
    `;
  } else if (includeResolved && numResults > 0) {
    rows = await sql`
      SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
             ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at
      FROM issues i
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN users nu ON nu.id = i.nominated_by_id
      ORDER BY i.id DESC
      LIMIT ${numResults}
    `;
  } else if (includeResolved) {
    rows = await sql`
      SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
             ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at
      FROM issues i
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN users nu ON nu.id = i.nominated_by_id
    `;
  } else if (numResults > 0) {
    rows = await sql`
      SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
             ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at
      FROM issues i
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN users nu ON nu.id = i.nominated_by_id
      WHERE i.resolved_at IS NULL
      ORDER BY i.id DESC
      LIMIT ${numResults}
    `;
  } else {
    rows = await sql`
      SELECT i.id, i.created_at, NOW() AT TIME ZONE 'utc' AS retrieved_at, i.project, i.summary,
             ou.name AS owner, nu.name AS nominated_by, i.acknowledged_at, i.fix_change, i.resolved_at
      FROM issues i
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN users nu ON nu.id = i.nominated_by_id
      WHERE i.resolved_at IS NULL
    `;
  }

  return rows.map((r) => ({
    Id: Number(r.id),
    CreatedAt: r.created_at as string,
    RetrievedAt: r.retrieved_at as string,
    Project: r.project as string,
    Summary: r.summary as string,
    Owner: r.owner as string | null,
    NominatedBy: r.nominated_by as string | null,
    AcknowledgedAt: r.acknowledged_at ?? null,
    FixChange: (r.fix_change as number) ?? 0,
    ResolvedAt: r.resolved_at ?? null,
    bNotify: userName != null ? r.watcher_user_id != null : false,
  }));
}
