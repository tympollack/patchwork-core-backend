import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

// ---------------------------------------------------------------------------
// Auth helper — matches hub cron-auth pattern
// cron-job.org sends: Authorization: Bearer <CRON_SECRET>
// ---------------------------------------------------------------------------
function verifyCronAuth(req: Request, res: Response): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[CRON] CRON_SECRET env var is not set');
    res.status(500).json({ error: 'Server misconfiguration' });
    return false;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// POST /api/cron/bounty-trigger
//
// Scheduled daily at 00:05 UTC by cron-job.org.
// Queries patchwork.nodes for nodes older than 7 days that haven't triggered
// a bounty yet, fires the critter-bounty webhook, then marks them.
// ---------------------------------------------------------------------------
router.post('/bounty-trigger', async (req: Request, res: Response): Promise<void> => {
  if (!verifyCronAuth(req, res)) return;

  const start = Date.now();
  console.log('[CRON] POST /api/cron/bounty-trigger — start');

  const webhookUrl = process.env.WEBHOOK_URL ?? 'https://api.patchwork.local/webhook/critter-bounty';
  const supabase   = getSupabaseAdmin();

  // Fetch eligible nodes: awaiting_verification, older than 7 days, not yet triggered
  const { data: nodes, error: fetchError } = await supabase
    .schema('patchwork')
    .from('nodes')
    .select('node_id, latitude, longitude, h3_index')
    .eq('status', 'awaiting_verification')
    .eq('bounty_triggered', false)
    .lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (fetchError) {
    console.error('[CRON] bounty-trigger fetch error:', fetchError.message);
    res.status(500).json({ error: 'Failed to query nodes', detail: fetchError.message });
    return;
  }

  let triggered = 0;
  let failed    = 0;

  for (const node of nodes ?? []) {
    try {
      const response = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          node_id:   node.node_id,
          h3_index:  node.h3_index,
          latitude:  node.latitude,
          longitude: node.longitude,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);

      // Mark bounty as triggered
      const { error: updateError } = await supabase
        .schema('patchwork')
        .from('nodes')
        .update({ bounty_triggered: true })
        .eq('node_id', node.node_id)
        .eq('bounty_triggered', false); // idempotency guard

      if (updateError) throw new Error(`DB update failed: ${updateError.message}`);

      triggered++;
      console.log(`[CRON] bounty triggered for node ${node.node_id}`);
    } catch (err) {
      failed++;
      console.error(`[CRON] bounty-trigger failed for node ${node.node_id}:`, err);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[CRON] bounty-trigger complete | triggered: ${triggered} | failed: ${failed} | ${elapsed}ms`);
  res.status(200).json({ ok: true, job: 'bounty-trigger', triggered, failed });
});

// ---------------------------------------------------------------------------
// POST /api/cron/archive-nodes
//
// Scheduled daily at 00:10 UTC by cron-job.org.
// Soft-archives awaiting_verification nodes older than 28 days.
// ---------------------------------------------------------------------------
router.post('/archive-nodes', async (req: Request, res: Response): Promise<void> => {
  if (!verifyCronAuth(req, res)) return;

  const start = Date.now();
  console.log('[CRON] POST /api/cron/archive-nodes — start');

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .schema('patchwork')
    .from('nodes')
    .update({ status: 'archived' })
    .eq('status', 'awaiting_verification')
    .lt('created_at', new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString())
    .select('node_id');

  if (error) {
    console.error('[CRON] archive-nodes error:', error.message);
    res.status(500).json({ error: 'Archive failed', detail: error.message });
    return;
  }

  const archived = data?.length ?? 0;
  const elapsed  = Date.now() - start;
  console.log(`[CRON] archive-nodes complete | archived: ${archived} | ${elapsed}ms`);
  res.status(200).json({ ok: true, job: 'archive-nodes', archived });
});

export default router;
