import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = Router();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BUCKET          = process.env.R2_BUCKET_NAME ?? 'patchwork-ports-stag';
const URL_EXPIRES_SECONDS = 900; // 15 minutes — generous for cellular field uplinks
const PRESIGN_TIMEOUT_MS  = 5000;

/**
 * Creates an S3-compatible client pointed at Cloudflare R2.
 * Mirrors the Cozy project R2 pattern exactly.
 * Env vars required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */
function getR2Client(): S3Client {
  const accountId        = process.env.R2_ACCOUNT_ID;
  const accessKeyId      = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey  = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing R2 env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  return new S3Client({
    region:   'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

/**
 * POST /api/ports/request-upload
 *
 * Returns a Cloudflare R2 presigned PUT URL (S3-compatible).
 * The mobile client uploads the raw image directly — no backend streaming.
 *
 * Timeout: if getSignedUrl does not resolve within PRESIGN_TIMEOUT_MS,
 * responds 503 Service Unavailable with Retry-After: 5.
 */
router.post('/request-upload', async (req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  console.log(`[TRACE] POST /api/ports/request-upload | body: ${JSON.stringify(req.body)}`);

  const attestation = mockHardwareAttestation();
  if (!attestation.success) {
    const elapsed = Date.now() - start;
    console.log(`[TRACE] POST /api/ports/request-upload | 403 | ${elapsed}ms | attestation_fail: ${attestation.reason}`);
    res.status(403).json({ error: 'Hardware attestation failed.', detail: attestation.reason });
    return;
  }

  const uploadId  = crypto.randomUUID();
  const objectKey = `ports/${uploadId}.jpg`;

  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         objectKey,
    ContentType: 'image/jpeg',
  });

  // Race presign against a hard timeout
  const timeoutSignal = AbortSignal.timeout(PRESIGN_TIMEOUT_MS);
  let presignedUrl: string;
  try {
    presignedUrl = await getSignedUrl(getR2Client(), command, {
      expiresIn: URL_EXPIRES_SECONDS,
      // @ts-ignore - abortSignal is passed through to the underlying credentials provider
      abortSignal: timeoutSignal,
    });
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('timeout'));

    if (isTimeout) {
      console.error(`[TRACE] POST /api/ports/request-upload | 503 | ${elapsed}ms | presign_timeout`);
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'Presign timeout — R2 unavailable, retry shortly.' });
    } else {
      console.error(`[TRACE] POST /api/ports/request-upload | 500 | ${elapsed}ms | r2_sdk_error |`, err);
      res.status(500).json({ error: 'Failed to generate upload URL.' });
    }
    return;
  }

  const elapsed = Date.now() - start;
  console.log(`[TRACE] POST /api/ports/request-upload | 200 | ${elapsed}ms | upload_id: ${uploadId}`);
  console.log(`[R2_DIAG] bucket: ${BUCKET} | object_key: ${objectKey} | expiresIn: ${URL_EXPIRES_SECONDS}s`);

  res.status(200).json({
    upload_id:         uploadId,
    presigned_url:     presignedUrl,
    object_key:        objectKey,
    method:            'PUT',
    required_headers:  { 'Content-Type': 'image/jpeg' },
    expires_in_seconds: URL_EXPIRES_SECONDS,
    attestation_status: 'mock_success',
  });
});

// ---------------------------------------------------------------------------
// Mock hardware attestation (placeholder for real device attestation)
// ---------------------------------------------------------------------------
function mockHardwareAttestation(): { success: true } | { success: false; reason: string } {
  return { success: true };
}

export default router;
