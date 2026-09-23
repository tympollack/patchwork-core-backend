import pool from './db';

async function teardown(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('Tearing down seed data...');

    await client.query(`DROP TABLE IF EXISTS public.field_notes CASCADE;`);
    console.log('✓ field_notes dropped');

    await client.query(`DROP TABLE IF EXISTS public.impact_reports CASCADE;`);
    console.log('✓ impact_reports dropped');

    await client.query(`DROP TABLE IF EXISTS public.nodes CASCADE;`);
    console.log('✓ nodes dropped');

    console.log('\n✅ Database is clean. Ready for field testing.');
  } catch (err) {
    console.error('Teardown failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

teardown().catch((err) => {
  console.error(err);
  process.exit(1);
});
