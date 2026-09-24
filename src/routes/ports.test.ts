/**
 * ports.test.ts
 * Unit tests for POST /api/ports/request-upload (R2 presigned URL generation).
 * Test runner: Vitest (matches hub + cozy pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mock @aws-sdk/* before importing the router.
// vi.mock is hoisted by Vitest automatically.
// ---------------------------------------------------------------------------
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((args: unknown) => args),
}));

// ---------------------------------------------------------------------------
// Helper: build a minimal mock Express req/res pair
// ---------------------------------------------------------------------------
function buildMockReqRes(body = {}) {
  const req    = { body, headers: {} } as unknown as Request;
  const json   = vi.fn().mockReturnThis();
  const set    = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json, set });
  const res    = { status, json, set } as unknown as Response;
  return { req, res, json, status, set };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/ports/request-upload', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...OLD_ENV,
      R2_ACCOUNT_ID:        'test-account-id',
      R2_ACCESS_KEY_ID:     'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_BUCKET_NAME:       'patchwork-ports-stag',
    };
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('happy path: returns presigned_url, upload_id, object_key', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    vi.mocked(getSignedUrl).mockResolvedValue('https://r2.test/presigned?sig=abc');

    const { default: router } = await import('./ports');
    const { req, res, json, status } = buildMockReqRes();

    const layer   = (router as any).stack.find((l: any) => l.route?.path === '/request-upload');
    const handler = layer?.route?.stack?.[0]?.handle;
    expect(handler).toBeDefined();

    await handler(req, res, vi.fn());

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        presigned_url: 'https://r2.test/presigned?sig=abc',
        upload_id:     expect.any(String),
        object_key:    expect.stringMatching(/^ports\/.+\.jpg$/),
        method:        'PUT',
      })
    );
  });

  it('presign timeout: returns 503', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.mocked(getSignedUrl).mockRejectedValue(timeoutErr);

    const { default: router } = await import('./ports');
    const { req, res, status } = buildMockReqRes();

    const layer   = (router as any).stack.find((l: any) => l.route?.path === '/request-upload');
    const handler = layer?.route?.stack?.[0]?.handle;
    await handler(req, res, vi.fn());

    expect(status).toHaveBeenCalledWith(503);
  });

  it('R2 SDK error: returns 500', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    vi.mocked(getSignedUrl).mockRejectedValue(new Error('Network failure'));

    const { default: router } = await import('./ports');
    const { req, res, status } = buildMockReqRes();

    const layer   = (router as any).stack.find((l: any) => l.route?.path === '/request-upload');
    const handler = layer?.route?.stack?.[0]?.handle;
    await handler(req, res, vi.fn());

    expect(status).toHaveBeenCalledWith(500);
  });
});
