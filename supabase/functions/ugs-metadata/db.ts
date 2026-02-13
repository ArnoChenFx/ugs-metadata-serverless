import postgres from "postgres";

const databaseUrl =
  Deno.env.get("SUPABASE_DB_URL") ?? Deno.env.get("DATABASE_URL");

if (!databaseUrl) {
  throw new Error(
    "SUPABASE_DB_URL or DATABASE_URL environment variable is required"
  );
}

export const sql = postgres(databaseUrl, {
  // Required when using Supabase connection pooler (pgBouncer in transaction mode)
  prepare: false,
  max: 10,
  idle_timeout: 20,
});

/**
 * Insert-or-get a project by name, returns its id.
 */
export async function getOrCreateProjectId(
  projectName: string
): Promise<number> {
  const [row] = await sql`
    INSERT INTO projects (name) VALUES (${projectName})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return Number(row.id);
}

/**
 * Find or create a user by name (normalized to uppercase), returns its id.
 */
export async function findOrAddUserId(name: string): Promise<number> {
  if (!name || name.length === 0) return -1;
  const normalized = name.toUpperCase();
  const [row] = await sql`
    INSERT INTO users (name) VALUES (${normalized})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return Number(row.id);
}
