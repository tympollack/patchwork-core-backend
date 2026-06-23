import pool from './db';

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    // PostGIS is installed in the 'patchwork' schema on this Supabase project.
    // Expand the search_path so GEOMETRY type and spatial functions resolve correctly.
    await client.query(`SET search_path TO public, patchwork, extensions;`);
    console.log('✓ postgis extension ready');

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pseudonym     TEXT NOT NULL,
        civic_weight  NUMERIC NOT NULL DEFAULT 1.0,
        port_points   INTEGER NOT NULL DEFAULT 0
      );
    `);
    console.log('✓ users table ready');

    // Create nodes table with PostGIS geometry column
    await client.query(`
      CREATE TABLE IF NOT EXISTS nodes (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tier                INTEGER NOT NULL DEFAULT 1,
        geom                GEOMETRY(Point, 4326) NOT NULL,
        custodian_id        UUID REFERENCES users(id) ON DELETE SET NULL,
        expires_at_yellow   TIMESTAMPTZ,
        expires_at_red      TIMESTAMPTZ
      );
    `);
    console.log('✓ nodes table ready');

    // Create GiST index on geom column (critical for spatial queries)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_nodes_geom
      ON nodes USING GIST (geom);
    `);
    console.log('✓ GiST index on nodes.geom ready');

    // Create ports table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ports (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id             UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        image_url           TEXT,
        image_hash          TEXT NOT NULL,
        hardware_signature  TEXT
      );
    `);
    console.log('✓ ports table ready');

    console.log('\nAll migrations completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
