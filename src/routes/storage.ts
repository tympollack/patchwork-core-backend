import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const BUCKET = 'node_images';
const SIGNED_URL_EXPIRES_SECONDS = 900; // 15 min — generous for cellular

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * POST /api/storage/request-upload
 *
 * Returns a Supabase Storage signed upload URL.
 * The mobile client PUTs the image directly to Supabase Storage.
 */
router.post('/request-upload', async (req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  console.log(`[TRACE] POST /api/storage/request-upload | body: ${JSON.stringify(req.body)}`);

  try {
    const supabase = getSupabaseAdmin();
    const uploadId = crypto.randomUUID();
    const objectPath = `ports/${uploadId}.jpg`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(objectPath);

    if (error || !data) {
      const elapsed = Date.now() - start;
      console.error(`[TRACE] POST /api/storage/request-upload | 500 Error | ${elapsed}ms |`, error);
      res.status(500).json({ error: 'Failed to generate upload URL.' });
      return;
    }

    const elapsed = Date.now() - start;
    console.log(`[TRACE] POST /api/storage/request-upload | 200 OK | ${elapsed}ms | upload_id: ${uploadId}`);
    res.status(200).json({
      upload_id: uploadId,
      presigned_url: data.signedUrl,
      object_path: objectPath,
      token: data.token,
      method: 'PUT',
      required_headers: { 'Content-Type': 'image/jpeg' },
      expires_in_seconds: SIGNED_URL_EXPIRES_SECONDS,
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[TRACE] POST /api/storage/request-upload | 500 Error | ${elapsed}ms |`, err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
