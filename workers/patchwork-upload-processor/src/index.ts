/// <reference types="@cloudflare/workers-types" />
/**
 * patchwork-core-worker
 * Unified Cloudflare Worker consolidating the PatchWork backend services (PTW-11):
 *
 * 1. HTTP API (fetch):
 *    - GET  /health                   — Health probe
 *    - POST /api/ports/request-upload — R2 S3-presigned PUT URL with Supabase JWT auth
 *    - POST /api/cron/bounty-trigger  — HTTP trigger for bounty cron (Bearer CRON_SECRET)
 *    - POST /api/cron/archive-nodes   — HTTP trigger for node archive (Bearer CRON_SECRET)
 *
 * 2. Cloudflare Queues Consumer (queue):
 *    - Receives R2 object:create event from patchwork-upload-queue
 *    - Computes SHA-256 via Web Crypto
 *    - Copies staging -> production R2 bucket (ports/prod/<uploadId>.jpg)
 *    - Calculates Uber H3 Resolution-10 cell index
 *    - Upserts patchwork.nodes in Supabase via REST API
 *    - Deletes staging object (cleanup)
 *
 * 3. Cloudflare Scheduled Cron Triggers (scheduled):
 *    - 00:05 UTC (5 0 * * *)  — Bounty trigger (7-day rule, critter-bounty webhook)
 *    - 00:10 UTC (10 0 * * *) — Archive nodes (28-day soft-archive)
 */

import { latLngToCell } from 'h3-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------------------------------------------------------------------------
// Environment & Bindings (wrangler.toml + wrangler secret put)
// ---------------------------------------------------------------------------
export interface Env {
  /** R2 staging bucket binding */
  R2_STAGING: R2Bucket;
  /** R2 production bucket binding */
  R2_PRODUCTION: R2Bucket;

  /** Supabase project URL */
  SUPABASE_URL: string;
  /** Supabase service role key (wrangler secret put SUPABASE_SERVICE_KEY) */
  SUPABASE_SERVICE_KEY: string;
  /** Supabase anon key (optional, falls back to service key for user auth check) */
  SUPABASE_ANON_KEY?: string;

  /** Cloudflare R2 S3 API credentials for presigning PUT URLs */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;

  /** Bearer token expected for HTTP cron triggers */
  CRON_SECRET?: string;
  /** Critter bounty webhook target URL */
  WEBHOOK_URL?: string;
}

// ---------------------------------------------------------------------------
// Queue Message Shape
// ---------------------------------------------------------------------------
interface R2EventMessage {
  account: string;
  bucket: string;
  object: {
    key: string;
    size: number;
    etag: string;
  };
  action: 'PutObject' | 'CopyObject' | 'CompleteMultipartUpload' | 'DeleteObject';
}

// ---------------------------------------------------------------------------
// CORS Headers
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// Helper: SHA-256 via Web Crypto
// ---------------------------------------------------------------------------
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Helper: Extract Upload ID from Key (ports/<uploadId>.jpg)
// ---------------------------------------------------------------------------
function extractUploadId(key: string): string | null {
  const match = key.match(/^ports\/([^/]+)\.jpg$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Helper: Authenticate Supabase JWT
// ---------------------------------------------------------------------------
async function verifySupabaseToken(env: Env, token: string): Promise<{ id: string } | null> {
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) {
    console.error('[AUTH] Missing SUPABASE_URL or SUPABASE key in worker env');
    return null;
  }

  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: key,
      },
    });

    if (!res.ok) return null;
    return (await res.json()) as { id: string };
  } catch (err) {
    console.error('[AUTH] Supabase token check failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Verify Bearer token for CRON endpoints
// ---------------------------------------------------------------------------
function verifyCronAuth(request: Request, env: Env): boolean {
  if (!env.CRON_SECRET) {
    console.error('[CRON] CRON_SECRET is not configured');
    return false;
  }
  const authHeader = request.headers.get('authorization');
  return authHeader === `Bearer ${env.CRON_SECRET}`;
}

// ---------------------------------------------------------------------------
// Helper: Upsert node record into patchwork.nodes via Supabase REST
// ---------------------------------------------------------------------------
async function upsertNode(
  env: Env,
  uploadId: string,
  imageKey: string,
  h3Index: string,
  sha256: string
): Promise<void> {
  const url = `${env.SUPABASE_URL}/rest/v1/nodes?on_conflict=node_id`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
      'Accept-Profile': 'patchwork',
      'Content-Profile': 'patchwork',
    },
    body: JSON.stringify({
      node_id: uploadId,
      image_key: imageKey,
      h3_index: h3Index,
      sha256_hash: sha256,
      sync_status: 'synced',
      status: 'awaiting_verification',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase upsert failed: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle Action: Execute Bounty Trigger (7-day rule)
// ---------------------------------------------------------------------------
export async function executeBountyTrigger(
  env: Env
): Promise<{ ok: boolean; job: string; triggered: number; failed: number }> {
  console.log('[CRON] executeBountyTrigger starting...');
  const webhookUrl = env.WEBHOOK_URL ?? 'https://api.patchwork.local/webhook/critter-bounty';
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Query eligible nodes from patchwork.nodes
  const queryUrl = `${env.SUPABASE_URL}/rest/v1/nodes?status=eq.awaiting_verification&bounty_triggered=eq.false&created_at=lt.${cutoff}&select=node_id,latitude,longitude,h3_index`;
  const fetchRes = await fetch(queryUrl, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Accept-Profile': 'patchwork',
      'Content-Profile': 'patchwork',
    },
  });

  if (!fetchRes.ok) {
    const errText = await fetchRes.text();
    throw new Error(`Failed to query eligible nodes: HTTP ${fetchRes.status} — ${errText}`);
  }

  const nodes = (await fetchRes.json()) as Array<{
    node_id: string;
    latitude: number;
    longitude: number;
    h3_index: string;
  }>;

  let triggered = 0;
  let failed = 0;

  for (const node of nodes) {
    try {
      const webhookRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_id: node.node_id,
          h3_index: node.h3_index,
          latitude: node.latitude,
          longitude: node.longitude,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!webhookRes.ok) throw new Error(`Webhook HTTP ${webhookRes.status}`);

      // Mark bounty as triggered
      const patchUrl = `${env.SUPABASE_URL}/rest/v1/nodes?node_id=eq.${node.node_id}&bounty_triggered=eq.false`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Accept-Profile': 'patchwork',
          'Content-Profile': 'patchwork',
        },
        body: JSON.stringify({ bounty_triggered: true }),
      });

      if (!patchRes.ok) throw new Error(`DB update failed: HTTP ${patchRes.status}`);

      triggered++;
      console.log(`[CRON] Bounty triggered for node ${node.node_id}`);
    } catch (err) {
      failed++;
      console.error(`[CRON] Bounty trigger failed for node ${node.node_id}:`, err);
    }
  }

  console.log(`[CRON] executeBountyTrigger complete: ${triggered} triggered, ${failed} failed`);
  return { ok: true, job: 'bounty-trigger', triggered, failed };
}

// ---------------------------------------------------------------------------
// Lifecycle Action: Execute Archive Nodes (28-day rule)
// ---------------------------------------------------------------------------
export async function executeArchiveNodes(
  env: Env
): Promise<{ ok: boolean; job: string; archived: number }> {
  console.log('[CRON] executeArchiveNodes starting...');
  const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const patchUrl = `${env.SUPABASE_URL}/rest/v1/nodes?status=eq.awaiting_verification&created_at=lt.${cutoff}`;
  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=representation',
      'Accept-Profile': 'patchwork',
      'Content-Profile': 'patchwork',
    },
    body: JSON.stringify({ status: 'archived' }),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw new Error(`Archive failed: HTTP ${patchRes.status} — ${errText}`);
  }

  const modified = (await patchRes.json()) as Array<{ node_id: string }>;
  const archived = Array.isArray(modified) ? modified.length : 0;
  console.log(`[CRON] executeArchiveNodes complete: ${archived} nodes archived`);
  return { ok: true, job: 'archive-nodes', archived };
}

// ---------------------------------------------------------------------------
// Worker Default Export
// ---------------------------------------------------------------------------
export default {
  /**
   * HTTP Fetch Handler — presigned upload endpoint, health check, cron webhooks
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json(
        { status: 'ok', timestamp: new Date().toISOString() },
        { headers: CORS_HEADERS }
      );
    }

    // POST /api/ports/request-upload
    if (url.pathname === '/api/ports/request-upload') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
      }

      // 1. Authenticate caller JWT
      const authHeader = request.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return Response.json(
          { error: 'Missing or malformed Authorization header.' },
          { status: 401, headers: CORS_HEADERS }
        );
      }

      const user = await verifySupabaseToken(env, authHeader.slice(7));
      if (!user) {
        return Response.json(
          { error: 'Invalid or expired token.' },
          { status: 401, headers: CORS_HEADERS }
        );
      }

      // 2. Hardware attestation (placeholder)
      const attestationSuccess = true;
      if (!attestationSuccess) {
        return Response.json(
          { error: 'Hardware attestation failed.' },
          { status: 403, headers: CORS_HEADERS }
        );
      }

      // 3. Verify S3 presigner credentials
      if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
        console.error('[PRESIGN] Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY in worker secrets');
        return Response.json(
          { error: 'Server misconfiguration: R2 credentials missing in Worker secrets.' },
          { status: 500, headers: CORS_HEADERS }
        );
      }

      const bucket = env.R2_BUCKET_NAME || 'patchwork-ports-stag';
      const uploadId = crypto.randomUUID();
      const objectKey = `ports/${uploadId}.jpg`;
      const expiresInSeconds = 900;

      try {
        const s3 = new S3Client({
          region: 'auto',
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          },
        });

        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: 'image/jpeg',
        });

        const timeoutSignal = AbortSignal.timeout(5000);
        const presignedUrl = await getSignedUrl(s3, command, {
          expiresIn: expiresInSeconds,
          // @ts-ignore
          abortSignal: timeoutSignal,
        });

        return Response.json(
          {
            upload_id: uploadId,
            presigned_url: presignedUrl,
            object_key: objectKey,
            method: 'PUT',
            required_headers: { 'Content-Type': 'image/jpeg' },
            expires_in_seconds: expiresInSeconds,
            attestation_status: 'mock_success',
          },
          { headers: CORS_HEADERS }
        );
      } catch (err: unknown) {
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('timeout'));

        if (isTimeout) {
          return new Response(
            JSON.stringify({ error: 'Presign timeout — R2 unavailable, retry shortly.' }),
            {
              status: 503,
              headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': '5' },
            }
          );
        }

        console.error('[PRESIGN] Error generating presigned URL:', err);
        return Response.json(
          { error: 'Failed to generate upload URL.' },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    // POST /api/cron/bounty-trigger (HTTP fallback for manual / webhook testing)
    if (url.pathname === '/api/cron/bounty-trigger') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
      }
      if (!verifyCronAuth(request, env)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
      }
      try {
        const res = await executeBountyTrigger(env);
        return Response.json(res, { headers: CORS_HEADERS });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
      }
    }

    // POST /api/cron/archive-nodes (HTTP fallback for manual / webhook testing)
    if (url.pathname === '/api/cron/archive-nodes') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
      }
      if (!verifyCronAuth(request, env)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS_HEADERS });
      }
      try {
        const res = await executeArchiveNodes(env);
        return Response.json(res, { headers: CORS_HEADERS });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
  },

  /**
   * Cloudflare Queues Handler — process raw R2 uploads asynchronously
   */
  async queue(batch: MessageBatch<R2EventMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;

      if (
        event.action !== 'PutObject' &&
        event.action !== 'CompleteMultipartUpload' &&
        event.action !== 'CopyObject'
      ) {
        console.log(`[WORKER] Skipping non-create event: ${event.action}`);
        message.ack();
        continue;
      }

      const key = event.object.key;
      const uploadId = extractUploadId(key);

      if (!uploadId) {
        console.warn(`[WORKER] Unrecognised key pattern, skipping: ${key}`);
        message.ack();
        continue;
      }

      console.log(`[WORKER] Processing upload | key: ${key} | uploadId: ${uploadId}`);

      try {
        // 1. Fetch object from R2 staging
        const stagingObj = await env.R2_STAGING.get(key);
        if (!stagingObj) throw new Error(`Object not found in staging: ${key}`);

        const buffer = await stagingObj.arrayBuffer();
        console.log(`[WORKER] Fetched ${buffer.byteLength} bytes from staging`);

        // 2. Compute SHA-256
        const sha256 = await sha256Hex(buffer);
        console.log(`[WORKER] SHA-256: ${sha256}`);

        // 3. Copy to production bucket
        const prodKey = `ports/prod/${uploadId}.jpg`;
        await env.R2_PRODUCTION.put(prodKey, buffer, {
          httpMetadata: { contentType: 'image/jpeg' },
          customMetadata: { sha256, source_key: key },
        });
        console.log(`[WORKER] Copied to production: ${prodKey}`);

        // 4. Compute H3 index
        const h3Index = latLngToCell(0, 0, 10); // overwritten on sync

        // 5. Upsert into patchwork.nodes
        await upsertNode(env, uploadId, prodKey, h3Index, sha256);
        console.log(`[WORKER] Supabase node upserted for uploadId: ${uploadId}`);

        // 6. Delete staging object
        await env.R2_STAGING.delete(key);
        console.log(`[WORKER] Staging object deleted: ${key}`);

        message.ack();
        console.log(`[WORKER] ✓ Processed ${uploadId} successfully`);
      } catch (err) {
        console.error(`[WORKER] ✗ Failed to process ${uploadId}:`, err);
        message.retry();
      }
    }
  },

  /**
   * Scheduled Cron Handler — native edge scheduler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] Scheduled event fired: ${event.cron}`);
    if (event.cron === '10 0 * * *') {
      ctx.waitUntil(executeArchiveNodes(env));
    } else {
      // 5 0 * * * or fallback
      ctx.waitUntil(executeBountyTrigger(env));
    }
  },
};
