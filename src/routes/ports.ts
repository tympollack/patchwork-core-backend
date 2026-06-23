import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = Router();

const BUCKET = 'patchwork-macro-ports';
const URL_EXPIRES_SECONDS = 900; // 15 minutes

function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
}

/**
 * POST /api/ports/request-upload
 *
 * Returns a standard AWS S3 presigned PUT URL. No client-side hash is
 * required — the mobile client uploads the raw image directly.
 */
router.post('/request-upload', async (req: Request, res: Response): Promise<void> => {
  const attestation = mockHardwareAttestation();
  if (!attestation.success) {
    res.status(403).json({ error: 'Hardware attestation failed.', detail: attestation.reason });
    return;
  }

  const uploadId = crypto.randomUUID();
  const objectKey = `ports/${uploadId}.jpg`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    ContentType: 'image/jpeg',
  });

  try {
    const presignedUrl = await getSignedUrl(getS3Client(), command, {
      expiresIn: URL_EXPIRES_SECONDS,
    });

    res.status(200).json({
      upload_id: uploadId,
      presigned_url: presignedUrl,
      object_key: objectKey,
      method: 'PUT',
      required_headers: {
        'Content-Type': 'image/jpeg',
      },
      expires_in_seconds: URL_EXPIRES_SECONDS,
      attestation_status: 'mock_success',
    });
  } catch (err) {
    console.error('Failed to generate presigned URL:', err);
    res.status(500).json({ error: 'Failed to generate upload URL.' });
  }
});

// ---------------------------------------------------------------------------
// Mock hardware attestation
// ---------------------------------------------------------------------------
function mockHardwareAttestation(): { success: true } | { success: false; reason: string } {
  return { success: true };
}

export default router;
