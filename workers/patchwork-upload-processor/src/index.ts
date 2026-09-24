/**
 * patchwork-upload-processor
 * Cloudflare Worker — triggered by R2 event notification on object:create
 * in the patchwork-ports-stag staging bucket.
 *
 * Pipeline:
 *   1. Fetch uploaded object from R2 staging bucket
 *   2. Compute SHA-256 hash via Web Crypto API
 *   3. Copy to production R2 bucket (ports/prod/<uploadId>.jpg)
 *   4. Compute H3 index at resolution 10
 *   5. Upsert node record into patchwork.nodes via Supabase REST
 *   6. Delete staging object (cleanup)
 */

import { latLngToCell } from 'h3-js';

// ---------------------------------------------------------------------------
// Bindings (declared in wrangler.toml)
// ---------------------------------------------------------------------------
export interface Env {
  /** R2 staging bucket binding */
  R2_STAGING: R2Bucket;
  /** R2 production bucket binding */
  R2_PRODUCTION: R2Bucket;
  /** Supabase project URL */
  SUPABASE_URL: string;
  /** Supabase service role key (set via: wrangler secret put SUPABASE_SERVICE_KEY) */
  SUPABASE_SERVICE_KEY: string;
}

// ---------------------------------------------------------------------------
// R2 event notification message shape
// ---------------------------------------------------------------------------
interface R2EventMessage {
  account:  string;
  bucket:   string;
  object: {
    key:    string;
    size:   number;
    etag:   string;
  };
  action:   'PutObject' | 'CopyObject' | 'CompleteMultipartUpload' | 'DeleteObject';
}

// ---------------------------------------------------------------------------
// Helper: compute SHA-256 of an ArrayBuffer using the Web Crypto API
// ---------------------------------------------------------------------------
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Helper: extract node_id and lat/lng from the object key or metadata
// Key pattern: ports/<uploadId>.jpg
// lat/lng must be written as custom metadata by the mobile client at upload time
// or resolved from the pending node record in Supabase.
// ---------------------------------------------------------------------------
function extractUploadId(key: string): string | null {
  const match = key.match(/^ports\/([^/]+)\.jpg$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Helper: upsert node record into patchwork.nodes via Supabase REST
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
      'Content-Type':  'application/json',
      'apikey':         env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        'resolution=merge-duplicates',
      'Accept-Profile': 'patchwork',
      'Content-Profile': 'patchwork',
    },
    body: JSON.stringify({
      node_id:     uploadId,
      image_key:   imageKey,
      h3_index:    h3Index,
      sha256_hash: sha256,
      sync_status: 'synced',
      status:      'awaiting_verification',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase upsert failed: HTTP ${response.status} — ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Worker default export
// Handles R2 event notifications via Cloudflare Queues consumer
// ---------------------------------------------------------------------------
export default {
  async queue(batch: MessageBatch<R2EventMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;

      // Only process object creation events
      if (
        event.action !== 'PutObject' &&
        event.action !== 'CompleteMultipartUpload' &&
        event.action !== 'CopyObject'
      ) {
        console.log(`[WORKER] Skipping event action: ${event.action}`);
        message.ack();
        continue;
      }

      const key      = event.object.key;
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
        // lat/lng fetched from Supabase pending record (written by mobile on quick-capture)
        // For now default to 0,0 as placeholder — real coords written by mobile client
        // via the sync endpoint on the full WatermelonDB sync flow
        const h3Index = latLngToCell(0, 0, 10); // placeholder — overwritten on sync

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
        // Nack — Cloudflare will retry according to queue consumer config
        message.retry();
      }
    }
  },
};
