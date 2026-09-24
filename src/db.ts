import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // PostGIS lives in the 'extensions' schema on Supabase; include 'patchwork' for
  // the new dedicated schema. This pool-level option applies to every connection so
  // pooled route queries (nodes.ts) can resolve ST_MakeEnvelope without a 500.
  options: '--search_path=public,patchwork,extensions',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export default pool;
