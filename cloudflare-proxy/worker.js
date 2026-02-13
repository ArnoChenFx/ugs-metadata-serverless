/**
 * Cloudflare Worker proxy for UGS Metadata Server.
 *
 * Transparently routes requests from your domain to a Supabase Edge Function.
 * UGS clients keep using the same URL with zero configuration changes.
 *
 * Configuration:
 *   Set SUPABASE_FUNCTION_URL in wrangler.toml [vars] or via `wrangler secret put`.
 */

export default {
  async fetch(request, env) {
    const supabaseUrl = env.SUPABASE_FUNCTION_URL;
    if (!supabaseUrl) {
      return new Response(
        JSON.stringify({ error: "SUPABASE_FUNCTION_URL not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const url = new URL(request.url);
    const targetUrl = supabaseUrl + url.pathname + url.search;

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
