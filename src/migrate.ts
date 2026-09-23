import pool from './db';

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    await client.query(`SET search_path TO public, patchwork, extensions;`);
    console.log('✓ search_path set');

    // -------------------------------------------------------------------------
    // nodes — the hub table
    // Replaces the old geometry-based nodes table with a flat lat/lng model
    // compatible with the mobile client's WatermelonDB schema.
    // -------------------------------------------------------------------------
    await client.query(`SET search_path TO public, auth;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.nodes (
        node_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        latitude    DOUBLE PRECISION NOT NULL,
        longitude   DOUBLE PRECISION NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','awaiting_verification','verified','denied'))
      );
    `);
    console.log('✓ nodes table ready');

    await client.query(`SET search_path TO public;`);
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);`);
      console.log('✓ idx_nodes_user created');
    } catch (e) {
      console.error('Failed to create idx_nodes_user:', e);
      throw e;
    }
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);`);
      console.log('✓ idx_nodes_status created');
    } catch (e) {
      console.error('Failed to create idx_nodes_status:', e);
      throw e;
    }
    console.log('✓ nodes indices ready');

    // -------------------------------------------------------------------------
    // impact_reports — private per-user damage paperwork
    // -------------------------------------------------------------------------
    await client.query(`SET search_path TO public, auth;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.impact_reports (
        report_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id      UUID NOT NULL REFERENCES public.nodes(node_id) ON DELETE CASCADE,
        user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        damage_type  TEXT NOT NULL,
        evidence_url TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✓ impact_reports table ready');

    await client.query(`SET search_path TO public;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_node ON impact_reports(node_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reports_user ON impact_reports(user_id);`);
    console.log('✓ impact_reports indices ready');

    // -------------------------------------------------------------------------
    // field_notes — public community descriptions
    // -------------------------------------------------------------------------
    await client.query(`SET search_path TO public, auth;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.field_notes (
        note_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id    UUID NOT NULL REFERENCES public.nodes(node_id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        note_text  TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✓ field_notes table ready');

    await client.query(`SET search_path TO public;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notes_node ON field_notes(node_id);`);
    console.log('✓ field_notes indices ready');

    // -------------------------------------------------------------------------
    // Enable Row Level Security on all three tables
    // -------------------------------------------------------------------------
    for (const table of ['nodes', 'impact_reports', 'field_notes']) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
    }
    console.log('✓ RLS enabled on all tables');

    // -------------------------------------------------------------------------
    // RLS policies — nodes
    //   • Any authenticated user can INSERT a pending node
    //   • Owners can UPDATE/DELETE their own node only while status = 'pending'
    //   • Verified nodes are globally read-only (no UPDATE/DELETE for anyone)
    //   • All authenticated users can SELECT all nodes
    // -------------------------------------------------------------------------
    await client.query(`DROP POLICY IF EXISTS nodes_select       ON public.nodes;`);
    await client.query(`DROP POLICY IF EXISTS nodes_insert       ON public.nodes;`);
    await client.query(`DROP POLICY IF EXISTS nodes_update_own   ON public.nodes;`);
    await client.query(`DROP POLICY IF EXISTS nodes_delete_own   ON public.nodes;`);

    await client.query(`
      CREATE POLICY nodes_select ON public.nodes
        FOR SELECT TO authenticated USING (true);
    `);
    await client.query(`
      CREATE POLICY nodes_insert ON public.nodes
        FOR INSERT TO authenticated
        WITH CHECK (auth.uid() = user_id AND status = 'pending');
    `);
    await client.query(`
      CREATE POLICY nodes_update_own ON public.nodes
        FOR UPDATE TO authenticated
        USING (auth.uid() = user_id AND status = 'pending')
        WITH CHECK (auth.uid() = user_id AND status = 'pending');
    `);
    await client.query(`
      CREATE POLICY nodes_delete_own ON public.nodes
        FOR DELETE TO authenticated
        USING (auth.uid() = user_id AND status = 'pending');
    `);
    console.log('✓ nodes RLS policies ready');

    // -------------------------------------------------------------------------
    // RLS policies — impact_reports (strictly private)
    // -------------------------------------------------------------------------
    await client.query(`DROP POLICY IF EXISTS reports_select_own ON public.impact_reports;`);
    await client.query(`DROP POLICY IF EXISTS reports_insert_own ON public.impact_reports;`);

    await client.query(`
      CREATE POLICY reports_select_own ON public.impact_reports
        FOR SELECT TO authenticated USING (auth.uid() = user_id);
    `);
    await client.query(`
      CREATE POLICY reports_insert_own ON public.impact_reports
        FOR INSERT TO authenticated
        WITH CHECK (auth.uid() = user_id);
    `);
    console.log('✓ impact_reports RLS policies ready');

    // -------------------------------------------------------------------------
    // RLS policies — field_notes (public read, own write)
    // -------------------------------------------------------------------------
    await client.query(`DROP POLICY IF EXISTS notes_select_all   ON public.field_notes;`);
    await client.query(`DROP POLICY IF EXISTS notes_insert_own   ON public.field_notes;`);
    await client.query(`DROP POLICY IF EXISTS notes_update_own   ON public.field_notes;`);
    await client.query(`DROP POLICY IF EXISTS notes_delete_own   ON public.field_notes;`);

    await client.query(`
      CREATE POLICY notes_select_all ON public.field_notes
        FOR SELECT TO authenticated USING (true);
    `);
    await client.query(`
      CREATE POLICY notes_insert_own ON public.field_notes
        FOR INSERT TO authenticated
        WITH CHECK (auth.uid() = user_id);
    `);
    await client.query(`
      CREATE POLICY notes_update_own ON public.field_notes
        FOR UPDATE TO authenticated
        USING (auth.uid() = user_id)
        WITH CHECK (auth.uid() = user_id);
    `);
    await client.query(`
      CREATE POLICY notes_delete_own ON public.field_notes
        FOR DELETE TO authenticated
        USING (auth.uid() = user_id);
    `);
    console.log('✓ field_notes RLS policies ready');

    console.log('\n✅ All migrations and RLS policies applied successfully.');
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
