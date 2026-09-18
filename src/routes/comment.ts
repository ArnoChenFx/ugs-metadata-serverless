import { Hono } from "hono";
import { sql, getOrCreateProjectId } from "../db.ts";
import { query, projectLikeString } from "../utils.ts";

export const commentRoutes = new Hono();

// GET /api/comment?Project=...&LastCommentId=...
commentRoutes.get("/", async (c) => {
  const project = query(c, "Project");
  const lastCommentId = query(c, "LastCommentId");
  if (!project || lastCommentId == null) {
    return c.json([], 200);
  }

  const like = projectLikeString(project);
  const rows = await sql`
    SELECT c.id, c.change_number, c.user_name, c.text, c.project
    FROM comments c
    INNER JOIN projects p ON p.id = c.project_id
    WHERE c.id > ${Number(lastCommentId)} AND p.name LIKE ${like}
    ORDER BY c.id
  `;

  const comments = rows
    .filter((r) => {
      const p = r.project as string | null;
      return p == null || p.toLowerCase() === project.toLowerCase();
    })
    .map((r) => ({
      Id: Number(r.id),
      ChangeNumber: r.change_number as number,
      UserName: r.user_name as string,
      Text: r.text as string,
      Project: r.project as string,
    }));

  return c.json(comments);
});

// POST /api/comment
commentRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const projectId = await getOrCreateProjectId(body.Project);

  await sql`
    INSERT INTO comments (change_number, user_name, text, project, project_id)
    VALUES (${body.ChangeNumber}, ${body.UserName}, ${body.Text}, ${body.Project}, ${projectId})
  `;

  return c.body(null, 200);
});
