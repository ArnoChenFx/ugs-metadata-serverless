import { Hono } from "hono";
import { buildRoutes } from "./routes/build.ts";
import { cisRoutes } from "./routes/cis.ts";
import { commentRoutes } from "./routes/comment.ts";
import { eventRoutes } from "./routes/event.ts";
import { errorRoutes } from "./routes/error.ts";
import { issuesRoutes } from "./routes/issues.ts";
import { issueBuildsRoutes } from "./routes/issue-builds.ts";
import { latestRoutes } from "./routes/latest.ts";
import { telemetryRoutes } from "./routes/telemetry.ts";
import { userRoutes } from "./routes/user.ts";

const app = new Hono().basePath("/ugs-metadata");

// Mount routes matching UGS client API paths
app.route("/api/build", buildRoutes);
app.route("/api/cis", cisRoutes);
app.route("/api/comment", commentRoutes);
app.route("/api/event", eventRoutes);
app.route("/api/error", errorRoutes);
app.route("/api/issues", issuesRoutes);
app.route("/api/issuebuilds", issueBuildsRoutes);
app.route("/api/latest", latestRoutes);
app.route("/api/telemetry", telemetryRoutes);
app.route("/api/user", userRoutes);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "UGS Metadata Server" }));

Deno.serve(app.fetch);
