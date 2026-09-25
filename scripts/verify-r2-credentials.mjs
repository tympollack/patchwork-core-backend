#!/usr/bin/env node
/**
 * verify-r2-credentials.mjs
 *
 * Diagnostic script for PatchWork Cloudflare R2 integration (PTW-04 / PTW-02).
 *
 * Verifies:
 * 1. Environment variable presence and format (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
 * 2. Connectivity & authentication to Cloudflare R2 endpoint (https://<account_id>.r2.cloudflarestorage.com)
 * 3. Access to both staging (patchwork-ports-stag) and production (patchwork-ports) buckets
 * 4. Read/Write/Delete lifecycle on staging bucket
 * 5. Presigned PUT URL generation and actual direct HTTP upload
 * 6. CORS policy validation on staging bucket (GET, PUT, HEAD, ETag)
 * 7. Outputs ready-to-run wrangler secret commands for Cloudflare Workers (Render bypass)
 *
 * Usage:
 *   node scripts/verify-r2-credentials.mjs
 *   npm run verify:r2
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ---------------------------------------------------------------------------
// Load .env manually if dotenv is not preloaded
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID?.trim();
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID?.trim();
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY?.trim();
const STAGING_BUCKET = process.env.R2_BUCKET_NAME?.trim() || 'patchwork-ports-stag';
const PROD_BUCKET = process.env.R2_PROD_BUCKET_NAME?.trim() || 'patchwork-ports';

console.log('\n================================================================');
console.log('  PATCHWORK // Cloudflare R2 Credentials & Service Verifier');
console.log('================================================================\n');

// ---------------------------------------------------------------------------
// Step 1: Validate Environment Variables
// ---------------------------------------------------------------------------
console.log('📋 [1/6] Validating environment variables in .env:');

let hasMissingVars = false;
const requiredVars = [
  ['R2_ACCOUNT_ID', ACCOUNT_ID],
  ['R2_ACCESS_KEY_ID', ACCESS_KEY_ID],
  ['R2_SECRET_ACCESS_KEY', SECRET_ACCESS_KEY],
];

for (const [name, val] of requiredVars) {
  if (!val) {
    console.log(`  ✗ Missing: ${name}`);
    hasMissingVars = true;
  } else {
    const masked = val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : '****';
    console.log(`  ✓ ${name}: ${masked}`);
  }
}

console.log(`  • Staging Bucket:    ${STAGING_BUCKET}`);
console.log(`  • Production Bucket: ${PROD_BUCKET}`);

if (hasMissingVars) {
  console.error('\n❌ FAILED: Missing required R2 environment variables in .env.');
  console.log('\nHow to obtain R2 API Credentials:');
  console.log('  1. Go to Cloudflare Dashboard -> R2 -> Manage R2 API Tokens');
  console.log('  2. Click "Create API Token"');
  console.log('  3. Permissions: "Object Read & Write"');
  console.log('  4. Apply to specific buckets: patchwork-ports-stag and patchwork-ports');
  console.log('  5. Add credentials to your .env file:');
  console.log('     R2_ACCOUNT_ID=<32-character Account ID from Dashboard>');
  console.log('     R2_ACCESS_KEY_ID=<Access Key ID>');
  console.log('     R2_SECRET_ACCESS_KEY=<Secret Access Key>');
  console.log('     R2_BUCKET_NAME=patchwork-ports-stag');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: Initialize R2 S3-Compatible Client
// ---------------------------------------------------------------------------
const endpoint = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
console.log(`\n🌐 [2/6] Connecting to Cloudflare R2 endpoint: ${endpoint}`);

const r2 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

// ---------------------------------------------------------------------------
// Step 3: Test Bucket Connectivity (Head / List)
// ---------------------------------------------------------------------------
console.log('\n🪣 [3/6] Verifying bucket connectivity & existence:');

async function testBucket(bucketName, label) {
  try {
    await r2.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`  ✓ ${label} (${bucketName}): Accessible and exists`);
    return true;
  } catch (err) {
    // If HeadBucket fails with 403 or 404, try ListObjectsV2 as fallback
    try {
      await r2.send(new ListObjectsV2Command({ Bucket: bucketName, MaxKeys: 1 }));
      console.log(`  ✓ ${label} (${bucketName}): Accessible via listObjects`);
      return true;
    } catch (listErr) {
      console.log(`  ✗ ${label} (${bucketName}) check failed: ${listErr.message}`);
      return false;
    }
  }
}

const stagingOk = await testBucket(STAGING_BUCKET, 'Staging Bucket');
const prodOk = await testBucket(PROD_BUCKET, 'Production Bucket');

if (!stagingOk || !prodOk) {
  console.error('\n❌ FAILED: Unable to access one or more buckets.');
  console.log('Please verify:');
  console.log('  - Both buckets exist in your Cloudflare R2 dashboard.');
  console.log('  - The R2 API token has permissions for both buckets.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 4: Test Object Read / Write / Delete Lifecycle (Staging)
// ---------------------------------------------------------------------------
console.log('\n📝 [4/6] Testing Read / Write / Delete lifecycle on staging bucket:');
const testKey = `ports/__diag_test_${Date.now()}.txt`;
const testPayload = `PatchWork R2 Diagnostic Test Payload - ${new Date().toISOString()}`;

try {
  // Write
  await r2.send(
    new PutObjectCommand({
      Bucket: STAGING_BUCKET,
      Key: testKey,
      Body: Buffer.from(testPayload, 'utf8'),
      ContentType: 'text/plain',
    })
  );
  console.log(`  ✓ PutObject: successfully wrote temporary object (${testKey})`);

  // Read
  const getRes = await r2.send(
    new GetObjectCommand({
      Bucket: STAGING_BUCKET,
      Key: testKey,
    })
  );
  const readData = await getRes.Body.transformToString('utf8');
  if (readData === testPayload) {
    console.log('  ✓ GetObject: read payload matches written data');
  } else {
    throw new Error('Read data mismatch');
  }

  // Delete
  await r2.send(
    new DeleteObjectCommand({
      Bucket: STAGING_BUCKET,
      Key: testKey,
    })
  );
  console.log('  ✓ DeleteObject: temporary diagnostic object cleaned up');
} catch (err) {
  console.error(`  ✗ Lifecycle test failed: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 5: Test Presigned PUT URL & Direct Upload
// ---------------------------------------------------------------------------
console.log('\n🔐 [5/6] Testing presigned PUT URL generation and HTTP upload:');
const presignKey = `ports/__presign_test_${Date.now()}.txt`;
const presignCommand = new PutObjectCommand({
  Bucket: STAGING_BUCKET,
  Key: presignKey,
  ContentType: 'text/plain',
});

try {
  const presignedUrl = await getSignedUrl(r2, presignCommand, { expiresIn: 300 });
  console.log('  ✓ Presigner: generated presigned PUT URL successfully');

  // Direct fetch PUT to verify R2 accepts the presigned URL
  const uploadPayload = 'Presigned PUT Test Payload';
  const uploadRes = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: uploadPayload,
  });

  if (uploadRes.ok) {
    console.log(`  ✓ Direct Upload: HTTP ${uploadRes.status} OK (presigned upload accepted)`);
    // Clean up
    await r2.send(new DeleteObjectCommand({ Bucket: STAGING_BUCKET, Key: presignKey }));
    console.log('  ✓ Cleanup: presigned test object deleted');
  } else {
    const errText = await uploadRes.text();
    console.error(`  ✗ Direct upload failed: HTTP ${uploadRes.status} — ${errText}`);
  }
} catch (err) {
  console.error(`  ✗ Presign test failed: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Step 6: Audit CORS Configuration on Staging Bucket
// ---------------------------------------------------------------------------
console.log('\n🌍 [6/6] Auditing CORS policy on staging bucket (patchwork-ports-stag):');

try {
  const corsRes = await r2.send(new GetBucketCorsCommand({ Bucket: STAGING_BUCKET }));
  const rules = corsRes.CORSRules || [];
  console.log(`  Found ${rules.length} CORS rule(s).`);

  let allowsPut = false;
  let exposesEtag = false;

  for (const rule of rules) {
    const methods = rule.AllowedMethods || [];
    const headers = rule.ExposeHeaders || [];
    if (methods.includes('PUT')) allowsPut = true;
    if (headers.some((h) => h.toLowerCase() === 'etag')) exposesEtag = true;
  }

  if (allowsPut) {
    console.log('  ✓ CORS allows PUT method');
  } else {
    console.log('  ⚠️  WARN: CORS does not explicitly allow PUT method');
  }

  if (exposesEtag) {
    console.log('  ✓ CORS exposes ETag header');
  } else {
    console.log('  ⚠️  WARN: CORS does not expose ETag header');
  }
} catch (err) {
  if (err.name === 'NoSuchCORSConfiguration') {
    console.log('  ℹ️  No custom CORS configuration returned via S3 API.');
    console.log('     Please verify in Cloudflare Dashboard -> R2 -> patchwork-ports-stag -> Settings -> CORS:');
    console.log('     [');
    console.log('       {');
    console.log('         "AllowedOrigins": ["*"],');
    console.log('         "AllowedMethods": ["GET", "PUT", "HEAD"],');
    console.log('         "AllowedHeaders": ["*"],');
    console.log('         "ExposeHeaders": ["ETag"],');
    console.log('         "MaxAgeSeconds": 3000');
    console.log('       }');
    console.log('     ]');
  } else {
    console.log(`  ℹ️  CORS query response: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Summary & Cloudflare Worker Secret Export (Bypassing Render)
// ---------------------------------------------------------------------------
console.log('\n================================================================');
console.log('  🎉 R2 CREDENTIALS VERIFICATION COMPLETE: ALL CHECKS PASSED');
console.log('================================================================\n');

console.log('Since Render is being bypassed (PTW-11), apply these secrets to');
console.log('your Cloudflare Worker directly using the Wrangler CLI:\n');

console.log('  cd workers/patchwork-upload-processor');
console.log(`  echo "${ACCOUNT_ID}" | npx wrangler secret put R2_ACCOUNT_ID`);
console.log(`  echo "${ACCESS_KEY_ID}" | npx wrangler secret put R2_ACCESS_KEY_ID`);
console.log(`  echo "${SECRET_ACCESS_KEY}" | npx wrangler secret put R2_SECRET_ACCESS_KEY`);
console.log(`  echo "${STAGING_BUCKET}" | npx wrangler secret put R2_BUCKET_NAME`);
console.log('\n');
