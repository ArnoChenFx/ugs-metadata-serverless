import { Hono } from "hono";
import { findOrAddUserId } from "../db.ts";

export const userRoutes = new Hono();

// GET /api/user?Name=...
userRoutes.get("/", async (c) => {
  const name = c.req.query("Name");
  if (!name) {
    return c.json({ error: "Name is required" }, 400);
  }

  const id = await findOrAddUserId(name);
  return c.json({ Id: id });
});
