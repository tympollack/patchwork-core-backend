/**
 * index.test.ts
 *
 * Comprehensive unit tests for the Unified Cloudflare Worker (PTW-11):
 * - HTTP Fetch Handler (health check, JWT auth, R2 S3-presigned PUT URL, cron webhooks)
 * - Cloudflare Queues Consumer (R2 staging fetch, SHA-256 hash, R2 prod copy, H3 index, Supabase upsert, staging cleanup)
 * - Cloudflare Scheduled Cron Triggers (bounty-trigger at 00:05 UTC, archive-nodes at 00:10 UTC)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mockGetSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((args: unknown) => args),
}));

import worker, { executeBountyTrigger, executeArchiveNodes } from './index';

const UPLOAD_ID = 'e171a48f-847c-48fb-8103-8a11ee5c721f';
const KEY = `ports/${UPLOAD_ID}.jpg`;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    R2_STAGING: {
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    R2_PRODUCTION: {
      put: vi.fn().mockResolvedValue(undefined),
    },
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-service-key',
    R2_ACCOUNT_ID: 'test-account-id',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_NAME: 'patchwork-ports-stag',
    CRON_SECRET: 'test-cron-secret',
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      action: 'PutObject',
      object: {
        key: KEY,
        size: IMAGE_BYTES.byteLength,
        etag: 'mock-etag-abc',
      },
      account: 'test-account',
      bucket: 'patchwork-ports-stag',
    },
    ack: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. HTTP Fetch Handler Tests (PTW-11)
// ---------------------------------------------------------------------------
describe('Worker HTTP Fetch Handler (worker.fetch)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health returns 200 with status ok and timestamp', async () => {
    const req = new Request('https://worker.test/health');
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    const req = new Request('https://worker.test/api/ports/request-upload', { method: 'OPTIONS' });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('POST /api/ports/request-upload returns 401 when Authorization header is missing', async () => {
    const req = new Request('https://worker.test/api/ports/request-upload', { method: 'POST' });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Authorization');
  });

  it('POST /api/ports/request-upload returns 401 when Supabase token verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid token' }),
    }));

    const req = new Request('https://worker.test/api/ports/request-upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-token' },
    });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(401);
  });

  it('POST /api/ports/request-upload returns 200 with presigned PUT URL and upload payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'usr-123' }),
    }));

    mockGetSignedUrl.mockResolvedValue(
      'https://patchwork-ports-stag.test-account-id.r2.cloudflarestorage.com/ports/test.jpg?X-Amz-Signature=abc'
    );

    const req = new Request('https://worker.test/api/ports/request-upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-jwt-token' },
    });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.upload_id).toBeDefined();
    expect(body.presigned_url).toContain('r2.cloudflarestorage.com');
    expect(body.method).toBe('PUT');
    expect(body.object_key).toMatch(/^ports\/[0-9a-f-]+\.jpg$/);
    expect(body.required_headers['Content-Type']).toBe('image/jpeg');
    expect(body.expires_in_seconds).toBe(900);
    expect(body.attestation_status).toBe('mock_success');
  });

  it('POST /api/cron/bounty-trigger rejects without Bearer CRON_SECRET', async () => {
    const req = new Request('https://worker.test/api/cron/bounty-trigger', { method: 'POST' });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);
    expect(res.status).toBe(401);
  });

  it('POST /api/cron/bounty-trigger executes successfully when authorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/v1/nodes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    }));

    const req = new Request('https://worker.test/api/cron/bounty-trigger', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.job).toBe('bounty-trigger');
  });

  it('POST /api/cron/archive-nodes executes successfully when authorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/rest/v1/nodes')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ node_id: 'node-archived-1' }],
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    }));

    const req = new Request('https://worker.test/api/cron/archive-nodes', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
    const env = makeEnv();
    const res = await worker.fetch(req, env as any);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.job).toBe('archive-nodes');
    expect(body.archived).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Cloudflare Queues Consumer Tests (worker.queue)
// ---------------------------------------------------------------------------
describe('Worker Queue Consumer (worker.queue)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: fetches staging, hashes, copies to prod, upserts Supabase, deletes staging, acks', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(IMAGE_BYTES.buffer),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    }));

    const msg = makeMessage();
    const batch = { messages: [msg] };

    await worker.queue(batch as any, env as any);

    expect(env.R2_STAGING.get).toHaveBeenCalledWith(KEY);
    expect(env.R2_PRODUCTION.put).toHaveBeenCalledWith(
      `ports/prod/${UPLOAD_ID}.jpg`,
      IMAGE_BYTES.buffer,
      expect.objectContaining({ httpMetadata: { contentType: 'image/jpeg' } })
    );
    expect(env.R2_STAGING.delete).toHaveBeenCalledWith(KEY);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('nacks (retries) when staging object is missing', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue(null);

    const msg = makeMessage();
    const batch = { messages: [msg] };

    await worker.queue(batch as any, env as any);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(env.R2_STAGING.delete).not.toHaveBeenCalled();
  });

  it('nacks when Supabase upsert fails', async () => {
    const env = makeEnv();
    (env.R2_STAGING.get as Mock).mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(IMAGE_BYTES.buffer),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));

    const msg = makeMessage();
    const batch = { messages: [msg] };

    await worker.queue(batch as any, env as any);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(env.R2_STAGING.delete).not.toHaveBeenCalled();
  });

  it('acks and skips non-create events', async () => {
    const env = makeEnv();
    const msg = makeMessage({
      body: {
        action: 'DeleteObject',
        object: { key: KEY, size: 0, etag: '' },
        account: 'test',
        bucket: 'stag',
      },
    });
    const batch = { messages: [msg] };

    await worker.queue(batch as any, env as any);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.R2_STAGING.get).not.toHaveBeenCalled();
  });

  it('acks and skips unrecognised key patterns', async () => {
    const env = makeEnv();
    const msg = makeMessage({
      body: {
        action: 'PutObject',
        object: { key: 'invalid/format.txt', size: 10, etag: 'x' },
        account: 'test',
        bucket: 'stag',
      },
    });
    const batch = { messages: [msg] };

    await worker.queue(batch as any, env as any);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.R2_STAGING.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Native Scheduled Cron Trigger Tests (worker.scheduled)
// ---------------------------------------------------------------------------
describe('Worker Scheduled Handler (worker.scheduled)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const env = makeEnv();

  it('triggers bounty-trigger for cron 5 0 * * *', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }));

    const ctx = { waitUntil: vi.fn((p) => p) };
    const event = { cron: '5 0 * * *', type: 'scheduled', scheduledTime: Date.now() };

    await worker.scheduled(event as any, env as any, ctx as any);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('triggers archive-nodes for cron 10 0 * * *', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }));

    const ctx = { waitUntil: vi.fn((p) => p) };
    const event = { cron: '10 0 * * *', type: 'scheduled', scheduledTime: Date.now() };

    await worker.scheduled(event as any, env as any, ctx as any);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });
});
