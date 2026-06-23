/**
 * test-s3.ts
 *
 * End-to-end test for the S3 presigned upload pipeline:
 *   1. Generate a dummy file in memory
 *   2. POST to /api/ports/request-upload -> receive presigned URL
 *   3. PUT the file to S3 using the presigned URL
 *   4. Report success / failure with full diagnostic output
 *
 * Usage:
 *   npx ts-node test-s3.ts
 *
 * Requires the Express server to be running on localhost:3000 and valid
 * AWS credentials in .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION).
 */

import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const SERVER = 'http://localhost:3000';

// --- Step 1: Generate a dummy file ---
function createDummyFile(): Buffer {
  const content = [
    'PatchWork S3 Pipeline Test',
    `Timestamp : ${new Date().toISOString()}`,
    `Random    : ${crypto.randomBytes(16).toString('hex')}`,
    'This is a dummy payload used to verify the upload pipeline.',
  ].join('\n');
  return Buffer.from(content, 'utf8');
}

// --- Main ---
(async () => {
  console.log('='.repeat(55));
  console.log('  PatchWork — S3 Presigned Upload Pipeline Test');
  console.log('='.repeat(55) + '\n');

  // Step 1 — create payload
  const fileBuffer = createDummyFile();
  console.log(`[1] Dummy file created (${fileBuffer.byteLength} bytes)`);
  console.log(`    Content:\n${fileBuffer.toString('utf8').split('\n').map(l => '    ' + l).join('\n')}\n`);

  // Step 2 — request presigned URL from our API
  console.log(`[2] Requesting presigned URL from ${SERVER}/api/ports/request-upload ...`);
  let presignedUrl: string;
  let objectKey: string;
  let requiredHeaders: Record<string, string>;

  try {
    const { data } = await axios.post(`${SERVER}/api/ports/request-upload`);
    presignedUrl = data.presigned_url;
    objectKey = data.object_key;
    requiredHeaders = data.required_headers;

    console.log(`    upload_id     : ${data.upload_id}`);
    console.log(`    object_key    : ${objectKey}`);
    console.log(`    expires_in    : ${data.expires_in_seconds}s`);
    console.log(`    attestation   : ${data.attestation_status}`);
    console.log(`    presigned_url : ${presignedUrl.slice(0, 120)}...`);
    console.log(`    required_headers:`);
    for (const [k, v] of Object.entries(requiredHeaders)) {
      console.log(`        ${k}: ${v}`);
    }
    console.log();
  } catch (err) {
    const e = err as AxiosError;
    console.error('    Failed to get presigned URL');
    console.error('      Status :', e.response?.status);
    console.error('      Body   :', JSON.stringify(e.response?.data, null, 2));
    process.exit(1);
  }

  // Step 3 — PUT the file directly to S3
  console.log(`[3] Uploading file to S3 via presigned URL ...`);
  console.log(`    Headers being sent:`);
  console.log(`        Content-Type   : image/jpeg`);
  console.log(`        Content-Length : ${fileBuffer.byteLength}`);
  console.log();

  try {
    const s3Response = await axios.put(presignedUrl, fileBuffer, {
      headers: {
        'Content-Type': requiredHeaders['Content-Type'] ?? 'image/jpeg',
        'Content-Length': fileBuffer.byteLength,
      },
      transformRequest: [(data) => data],
      maxBodyLength: Infinity,
    });

    console.log(`    S3 Response Status : ${s3Response.status} ${s3Response.statusText}`);
    console.log(`    ETag               : ${s3Response.headers['etag'] ?? '(not returned)'}`);
    console.log(`    Object URL         : https://${process.env.AWS_S3_BUCKET ?? 'patchwork-macro-ports'}.s3.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${objectKey}`);
    console.log();
    console.log('='.repeat(55));
    console.log('  RESULT: PASS — File uploaded successfully to S3');
    console.log('='.repeat(55));
  } catch (err) {
    const e = err as AxiosError;
    console.error(`    S3 PUT failed`);
    console.error(`      Status  : ${e.response?.status} ${e.response?.statusText}`);
    const body = e.response?.data;
    console.error(`      Body    : ${typeof body === 'string' ? body.slice(0, 800) : JSON.stringify(body)}`);
    console.log();
    console.log('='.repeat(55));
    console.log('  RESULT: FAIL — See error above');
    console.log('='.repeat(55));
    process.exit(1);
  }
})();
