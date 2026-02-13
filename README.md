# UGS Metadata Server — Serverless Edition

A modern, serverless re-implementation of Epic's [UnrealGameSync](https://docs.unrealengine.com/en-US/unreal-game-sync/) Metadata Server.

The original server is a legacy ASP.NET / IIS / MySQL stack that's painful to set up and maintain. This project replaces it with **Supabase** (PostgreSQL + Edge Functions) and an optional **Cloudflare Worker** proxy — giving you a fully managed, zero-maintenance backend that costs nothing for small teams.

## How It Works

```
UGS Desktop App
      │
      ▼
┌─────────────────────┐
│  Cloudflare Worker   │  ← optional proxy (keeps your existing URL working)
│  (ugs.yourteam.com) │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Supabase Edge Fn   │  ← Hono (TypeScript) handles all /api/* routes
│  (ugs-metadata)     │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Supabase Postgres   │  ← stores builds, reviews, comments, issues
└─────────────────────┘
```

**UGS clients don't need any changes** — the API is a 1:1 match with the original server.

## Features

- **Drop-in compatible** with the original ASP.NET MetadataServer — all endpoints, query parameters, and JSON shapes are preserved
- **Serverless** — no servers to manage, scales to zero, auto-scales up
- **Free tier friendly** — Supabase free tier + Cloudflare free tier is enough for most teams
- **Fast** — Edge Functions run close to your users, Cloudflare Worker adds zero latency
- **Simple** — one `supabase functions deploy` and you're live

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (for `npx`)
- A [Supabase](https://supabase.com/) account (free tier works)
- *(Optional)* A [Cloudflare](https://cloudflare.com/) account if you want a custom domain

## Quick Start

### 1. Create a Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New Project**
2. Choose a name, region, and database password
3. Note your **Project Ref** (the ID in the dashboard URL)

### 2. Deploy

```bash
# Clone this repo
git clone https://github.com/yourorg/ugs-metadata-server.git
cd ugs-metadata-server

# Link to your Supabase project
npx supabase login
npx supabase link --project-ref <your-project-ref>

# Apply the database schema
npx supabase db push

# Deploy the Edge Function
npx supabase functions deploy ugs-metadata --no-verify-jwt
```

That's it. Your server is live at:
```
https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata
```

### 3. Test It

```bash
# Health check
curl https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata/api/latest

# Should return:
# {"LastEventId":0,"LastCommentId":0,"LastBuildId":0}
```

### 4. Configure UGS

In your UGS configuration, set the API URL to:

```
https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata
```

UGS appends `/api/latest`, `/api/build`, etc. automatically.

> **Tip:** If you're configuring via `DefaultEngine.ini`:
> ```ini
> [/Script/UnrealGameSync.UnrealGameSyncSettings]
> ApiUrl=https://<your-project-ref>.supabase.co/functions/v1/ugs-metadata
> ```

## Custom Domain (Optional)

If you already have a domain like `ugs.yourteam.com` pointing to an old server, you can keep that URL working with a Cloudflare Worker proxy.

### Setup

1. **DNS**: In Cloudflare, add an A record for `ugs` → `192.0.2.1` with **Proxy ON** (orange cloud). The IP is a dummy — the Worker intercepts all traffic.

2. **Configure & Deploy**:
   ```bash
   cd cloudflare-proxy

   # Edit wrangler.toml:
   #   - Set SUPABASE_FUNCTION_URL to your Edge Function URL
   #   - Uncomment and set the routes to your domain

   npx wrangler login
   npx wrangler deploy
   ```

3. Done — `http://ugs.yourteam.com/api/latest` now proxies to Supabase.

## API Reference

All endpoints match the original MetadataServer exactly.

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/latest?Project=...` | Get latest event/comment/build IDs for delta sync |
| `GET` | `/api/build?Project=...&LastBuildId=...` | Get builds since a given ID |
| `POST` | `/api/build` | Submit a build result |
| `GET` | `/api/event?Project=...&LastEventId=...` | Get user reviews/votes since a given ID |
| `POST` | `/api/event` | Submit a review (Good, Bad, Investigating, etc.) |
| `GET` | `/api/comment?Project=...&LastCommentId=...` | Get comments since a given ID |
| `POST` | `/api/comment` | Post a comment on a changelist |
| `GET` | `/api/user?Name=...` | Find or create a user |

### Issue Tracking

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/issues` | List issues (filter: `?IncludeResolved`, `?MaxResults`, `?User`) |
| `GET` | `/api/issues/:id` | Get a single issue |
| `POST` | `/api/issues` | Create an issue |
| `PUT` | `/api/issues/:id` | Update an issue |
| `DELETE` | `/api/issues/:id` | Delete an issue |
| `GET/POST` | `/api/issues/:id/builds` | Issue builds |
| `GET/POST` | `/api/issues/:id/diagnostics` | Issue diagnostics |
| `GET/POST/DELETE` | `/api/issues/:id/watchers` | Issue watchers |
| `GET` | `/api/issuebuilds/:id` | Get a specific issue build |
| `PUT` | `/api/issuebuilds/:id` | Update a build outcome |

### Telemetry

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/telemetry?Version=...&IpAddress=...` | Submit timing telemetry |
| `GET` | `/api/error?Records=10` | Get recent errors |
| `POST` | `/api/error?Version=...&IpAddress=...` | Submit error telemetry |

### Legacy

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/cis` | Deprecated — proxies to build/latest (kept for backward compat) |

## Project Structure

```
ugs-metadata-server/
├── supabase/
│   ├── config.toml                          # Supabase project config
│   ├── migrations/
│   │   └── 00001_initial_schema.sql         # PostgreSQL schema
│   └── functions/
│       └── ugs-metadata/
│           ├── deno.json                    # Import map (Hono, postgres)
│           ├── index.ts                     # Hono app entry point
│           ├── db.ts                        # Database connection & helpers
│           ├── utils.ts                     # Shared utilities & enum maps
│           └── routes/
│               ├── build.ts                 # /api/build
│               ├── cis.ts                   # /api/cis (legacy)
│               ├── comment.ts               # /api/comment
│               ├── error.ts                 # /api/error
│               ├── event.ts                 # /api/event
│               ├── issue-builds.ts          # /api/issuebuilds
│               ├── issues.ts                # /api/issues + sub-resources
│               ├── latest.ts                # /api/latest
│               ├── telemetry.ts             # /api/telemetry
│               └── user.ts                  # /api/user
├── cloudflare-proxy/
│   ├── worker.js                            # Cloudflare Worker proxy
│   └── wrangler.toml                        # Wrangler config
├── .env.example
├── .gitignore
└── README.md
```

## Local Development

```bash
# Start local Supabase (requires Docker)
npx supabase start

# Apply migrations locally
npx supabase db reset

# Serve the Edge Function locally
npx supabase functions serve ugs-metadata --no-verify-jwt

# The function is now available at:
#   http://localhost:54321/functions/v1/ugs-metadata/api/latest
```

## Differences from the Original

| | Original (ASP.NET) | This Project |
|---|---|---|
| **Runtime** | .NET Framework 4.6.2 + IIS | Deno (Supabase Edge Functions) |
| **Database** | MySQL 8.0 | PostgreSQL 17 (Supabase) |
| **Hosting** | Windows Server / IIS | Serverless (Supabase + Cloudflare) |
| **Auth** | None | None (same as original) |
| **Cost** | Windows Server license + VM | Free tier for small teams |
| **Setup time** | Hours (IIS, MySQL, .NET, config) | Minutes |
| **Maintenance** | OS patches, IIS config, MySQL backups | Zero |

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

[MIT](LICENSE)
