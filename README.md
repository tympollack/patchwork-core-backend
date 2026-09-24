# PatchWork Core Backend

Express 5 + TypeScript backend for the PatchWork civic infrastructure mapping platform.

## Architecture

```
Mobile Client (React Native / Expo)
        │
        │  POST /api/ports/request-upload  (JWT required)
        ▼
 patchwork-core-backend  (Render — Node 20 / Express 5)
        │
        │  Returns R2 presigned PUT URL
        ▼
 Cloudflare R2 — patchwork-ports-stag  (staging bucket)
        │
        │  R2 object:create → Queue notification
        ▼
 Cloudflare Worker — patchwork-upload-processor
   1. SHA-256 via Web Crypto
   2. Copy staging → patchwork-ports  (production bucket)
   3. Upsert patchwork.nodes via Supabase REST
   4. Delete staging object
        │
        ▼
 Supabase Postgres — patchwork schema
   • patchwork.nodes
   • patchwork.impact_reports
   • patchwork.field_notes
```

> **Schema ownership:** The `patchwork` schema is provisioned exclusively by
> [`sunshade-db-platform`](https://github.com/tympollack/sunshade-db-platform)
> via Supabase migrations. Do not run `src/migrate.ts` against production — it
> manages only the legacy `public.nodes` table and is deprecated.

> **AWS / SAM retired:** The `sam/` directory is kept for reference only.
> Do **not** deploy the SAM stack. See [`sam/RETIRED.md`](sam/RETIRED.md) for
> the migration map and teardown instructions.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- A Supabase project with the `patchwork` schema applied
- Cloudflare account with R2 enabled

### Setup

```bash
# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env
# Edit .env — see Environment Variables section below

# Run the dev server
npm run dev
```

## Testing

```bash
# Run all tests (vitest)
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

Test suites:
- `src/routes/ports.test.ts` — presign endpoint (happy path, timeout 503, SDK error 500)
- `src/routes/worker.test.ts` — Cloudflare Worker queue consumer (ack, retry, R2 cleanup, Supabase payload)

## API Reference

All storage-write endpoints require a valid Supabase JWT:
```
Authorization: Bearer <supabase_access_token>
```

### `POST /api/ports/request-upload`

Returns a Cloudflare R2 presigned PUT URL. The mobile client uploads the raw image directly.

**Response:**
```json
{
  "upload_id":   "e171a48f-847c-48fb-8103-8a11ee5c721f",
  "presigned_url": "https://...",
  "object_key":  "ports/e171a48f-847c-48fb-8103-8a11ee5c721f.jpg",
  "method":      "PUT",
  "required_headers": { "Content-Type": "image/jpeg" },
  "expires_in_seconds": 900
}
```

**Error responses:**
- `401` — Missing or invalid JWT
- `403` — Hardware attestation failed
- `503` — R2 presign timed out (`Retry-After: 5`)
- `500` — R2 SDK error

### `POST /api/cron/bounty-trigger`
### `POST /api/cron/archive-nodes`

Called by cron-job.org. Auth: `Authorization: Bearer <CRON_SECRET>`.

### `GET /health`

Returns `{ status: "ok", timestamp: "..." }`. No auth required.

## Environment Variables

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Supabase Postgres connection string |
| `PORT` | — | Server port (default: 3000) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service role key (for cron queries) |
| `SUPABASE_ANON_KEY` | ✅ | Anon key (for JWT validation in requireAuth) |
| `R2_ACCOUNT_ID` | ✅ | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | ✅ | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | ✅ | R2 API token secret key |
| `R2_BUCKET_NAME` | ✅ | Staging bucket name (e.g. `patchwork-ports-stag`) |
| `R2_PUBLIC_URL` | — | Custom R2 domain for public asset URLs |
| `CRON_SECRET` | ✅ | Bearer token expected from cron-job.org |
| `WEBHOOK_URL` | ✅ | Critter-bounty webhook target URL |

## Cloudflare Worker Setup

The worker lives in `workers/patchwork-upload-processor/`. After merging:

```bash
cd workers/patchwork-upload-processor
npm install

# Set secrets (never commit these)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY

# Deploy
wrangler deploy
```

Required Cloudflare resources (create in dashboard before deploying):
1. R2 bucket `patchwork-ports-stag` (staging)
2. R2 bucket `patchwork-ports` (production)
3. Queue `patchwork-upload-queue`
4. Queue `patchwork-upload-dlq` (dead-letter)
5. R2 event notification on `patchwork-ports-stag` → `patchwork-upload-queue` (trigger: `object:create`)

## Cron Jobs (cron-job.org)

| Job | URL | Schedule | Auth |
|-----|-----|----------|------|
| Bounty trigger | `POST /api/cron/bounty-trigger` | Daily 00:05 UTC | `Authorization: Bearer <CRON_SECRET>` |
| Archive nodes | `POST /api/cron/archive-nodes` | Daily 00:10 UTC | `Authorization: Bearer <CRON_SECRET>` |

## Deployment (Render)

Set all env vars from the table above in the Render dashboard, then push to `staging`.
Render auto-deploys on branch push.

---

**Built with TDD principles** ✅ All tests passing before deployment
