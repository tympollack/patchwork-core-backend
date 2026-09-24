/**
 * patchwork-upload-processor.test.ts
 *
 * Unit tests for the Cloudflare Worker queue consumer.
 * Tests cover: happy-path pipeline, queue ack/retry on failure, R2 cleanup,
 * Supabase upsert payload shape, and key-pattern filtering.
 *
 * The Worker uses Web Crypto and fetch — both are available as globals in
 * the vitest environment (Node 20+) so no extra polyfills are needed.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Inline the helpers we want to unit-test without importing the full Worker
// (which requires Cloudflare Workers runtime globals like R2Bucket)
// ---------------------------------------------------------------------------

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractUploadId(key: string): string | null {
  const match = key.match(/^ports\/([^/]+)\.jpg$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Minimal mock env builder
// ---------------------------------------------------------------------------
function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    R2_STAGING: {
      get:    vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    R2_PRODUCTION: {
      put: vi.fn().mockResolvedValue(undefined),
    },
    SUPABASE_URL:         'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-service-key',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal R2ObjectBody-alike
// ---------------------------------------------------------------------------
function makeR2Object(bytes: Uint8Array) {
  return {
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
  };
}

// ---------------------------------------------------------------------------
// sha256Hex helper
// ---------------------------------------------------------------------------
describe('sha256Hex', () => {
  it('returns a 64-character lowercase hex string', async () => {
    const input  = new TextEncoder().encode('hello-patchwork');
    const result = await sha256Hex(input.buffer);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', async () => {
    const buf = new TextEncoder().encode('stable').buffer;
    expect(await sha256Hex(buf)).toBe(await sha256Hex(buf));
  });

  it('produces different digests for different inputs', async () => {
    const a = await sha256Hex(new TextEncoder().encode('aaa').buffer);
    const b = await sha256Hex(new TextEncoder().encode('bbb').buffer);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// extractUploadId helper
// ---------------------------------------------------------------------------
describe('extractUploadId', () => {
  it('extracts UUID from valid key', () => {
    const id = 'e171a48f-847c-48fb-8103-8a11ee5c721f';
    expect(extractUploadId(`ports/${id}.jpg`)).toBe(id);
  });

  it('returns null for unknown key patterns', () => {
    expect(extractUploadId('random/path.jpg')).toBeNull();
    expect(extractUploadId('ports/')).toBeNull();
    expect(extractUploadId('ports/subdir/file.jpg')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full queue consumer integration — mock Cloudflare Workers runtime
// ---------------------------------------------------------------------------

// Re-implement the worker's queue handler inline so we can drive it with
// fabricated MessageBatch objects without the Workers runtime.
async function runWorkerQueue(
  messages: Array<{ body: unknown; ack: Mock; retry: Mock }>,
  env: ReturnType<typeof makeEnv>
) {
  for (const message of messages) {
    const event = message.body as any;

    if (
      event.action !== 'PutObject' &&
      event.action !== 'CompleteMultipartUpload' &&
      event.action !== 'CopyObject'
    ) {
      message.ack();
      continue;
    }

    const key      = event.object.key;
    const uploadId = extractUploadId(key);

    if (!uploadId) {
      message.ack();
      continue;
    }

    try {
      const stagingObj = await (env.R2_STAGING.get as Mock)(key);
      if (!stagingObj) throw new Error(`Object not found in staging: ${key}`);

      const buffer  = await stagingObj.arrayBuffer();
      const sha256  = await sha256Hex(buffer);
      const prodKey = `ports/prod/${uploadId}.jpg`;

      await (env.R2_PRODUCTION.put as Mock)(prodKey, buffer, {
        httpMetadata:   { contentType: 'image/jpeg' },
        customMetadata: { sha256, source_key: key },
      });

      // Supabase upsert
      const fetchSpy = global.fetch as Mock;
      const upsertResp = await fetchSpy(`${env.SUPABASE_URL}/rest/v1/nodes?on_conflict=node_id`, {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'apikey':          env.SUPABASE_SERVICE_KEY,
          'Authorization':   `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Prefer':          'resolution=merge-duplicates',
          'Accept-Profile':  'patchwork',
          'Content-Profile': 'patchwork',
        },
        body: JSON.stringify({
          node_id:     uploadId,
          image_key:   prodKey,
          h3_index:    '8a2a1072b59ffff', // vitest placeholder
          sha256_hash: sha256,
          sync_status: 'synced',
          status:      'awaiting_verification',
        }),
      });
      if (!upsertResp.ok) {
        const errBody = await upsertResp.text();
        throw new Error(`Supabase upsert failed: HTTP ${upsertResp.status} — ${errBody.slice(0, 200)}`);
      }

      await (env.R2_STAGING.delete as Mock)(key);
      message.ack();
    } catch (err) {
      message.retry();
    }
  }
}

describe('Worker queue consumer', () => {
  const UPLOAD_ID = 'e171a48f-847c-48fb-8103-8a11ee5c721f';
  const KEY       = `ports/${UPLOAD_ID}.jpg`;
  const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes

  function makeMessage(overrides: Partial<{ body: unknown }> = {}) {
    return {
      body:  { action: 'PutObject', object: { key: KEY, size: 4, etag: 'abc' }, account: 'test', bucket: 'stag', ...((overrides.body ?? {}) as object) },
      ack:   vi.fn(),
      retry: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: fetches, hashes, copies to prod, upserts, deletes staging, acks', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue(makeR2Object(IMAGE_BYTES));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }));

    const msg = makeMessage();
    await runWorkerQueue([msg], env as any);

    // R2 staging fetched
    expect(env.R2_STAGING.get).toHaveBeenCalledWith(KEY);
    // Production copy written with correct key and SHA-256 metadata
    expect(env.R2_PRODUCTION.put).toHaveBeenCalledWith(
      `ports/prod/${UPLOAD_ID}.jpg`,
      IMAGE_BYTES.buffer,
      expect.objectContaining({ httpMetadata: { contentType: 'image/jpeg' } })
    );
    // R2 put metadata includes SHA-256
    const putCall = (env.R2_PRODUCTION.put as Mock).mock.calls[0][2] as any;
    expect(putCall.customMetadata.sha256).toHaveLength(64);
    // Supabase upsert called
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/nodes'),
      expect.objectContaining({ method: 'POST' })
    );
    // Upsert body contains required fields
    const fetchBody = JSON.parse((global.fetch as Mock).mock.calls[0][1].body);
    expect(fetchBody).toMatchObject({
      node_id:     UPLOAD_ID,
      image_key:   `ports/prod/${UPLOAD_ID}.jpg`,
      sha256_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sync_status: 'synced',
      status:      'awaiting_verification',
    });
    // Staging deleted
    expect(env.R2_STAGING.delete).toHaveBeenCalledWith(KEY);
    // Message acked
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('nacks (retries) when staging object is missing', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue(null); // object not found

    const msg = makeMessage();
    await runWorkerQueue([msg], env as any);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(env.R2_STAGING.delete).not.toHaveBeenCalled();
  });

  it('nacks when Supabase upsert fails', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue(makeR2Object(IMAGE_BYTES));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:     false,
      status: 500,
      text:   async () => 'Internal Server Error',
    }));

    const msg = makeMessage();
    await runWorkerQueue([msg], env as any);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    // Staging NOT deleted when pipeline fails
    expect(env.R2_STAGING.delete).not.toHaveBeenCalled();
  });

  it('acks and skips DeleteObject events without processing', async () => {
    const env = makeEnv();
    const msg = makeMessage({ body: { action: 'DeleteObject', object: { key: KEY, size: 0, etag: '' }, account: 'test', bucket: 'stag' } });

    await runWorkerQueue([msg], env as any);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.R2_STAGING.get).not.toHaveBeenCalled();
    expect(env.R2_PRODUCTION.put).not.toHaveBeenCalled();
  });

  it('acks and skips messages with unrecognised key patterns', async () => {
    const env = makeEnv();
    const msg = makeMessage({ body: { action: 'PutObject', object: { key: 'unknown/path/file.png', size: 10, etag: 'x' }, account: 'test', bucket: 'stag' } });

    await runWorkerQueue([msg], env as any);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.R2_STAGING.get).not.toHaveBeenCalled();
  });

  it('processes each message in a batch independently', async () => {
    const env  = makeEnv();
    const id2  = 'aaaaaaaa-0000-0000-0000-000000000001';
    const key2 = `ports/${id2}.jpg`;

    (env.R2_STAGING.get as Mock).mockResolvedValue(makeR2Object(IMAGE_BYTES));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }));

    const msg1 = makeMessage();
    const msg2 = makeMessage({ body: { action: 'PutObject', object: { key: key2, size: 4, etag: 'def' }, account: 'test', bucket: 'stag' } });

    await runWorkerQueue([msg1, msg2], env as any);

    expect(msg1.ack).toHaveBeenCalledTimes(1);
    expect(msg2.ack).toHaveBeenCalledTimes(1);
    expect(env.R2_STAGING.delete).toHaveBeenCalledTimes(2);
  });
});
