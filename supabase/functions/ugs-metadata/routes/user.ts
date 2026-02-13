import { Hono } from "hono";
import { findOrAddUserId } from "../db.ts";
import { query } from "../utils.ts";

export const userRoutes = new Hono();

// GET /api/user?Name=...
userRoutes.get("/", async (c) => {
  const name = query(c, "Name");
  if (!name) {
    return c.json({ error: "Name is required" }, 400);
  }

  const id = await findOrAddUserId(name);
  return c.json({ Id: id });
});
