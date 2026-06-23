import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

/**
 * GET /api/nodes
 * Query params: min_lat, min_lng, max_lat, max_lng
 *
 * Returns all nodes within the bounding box using ST_MakeEnvelope.
 * Node health state is computed lazily via SQL CASE against NOW().
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { min_lat, min_lng, max_lat, max_lng } = req.query;

  if (!min_lat || !min_lng || !max_lat || !max_lng) {
    res.status(400).json({
      error: 'Missing required query parameters: min_lat, min_lng, max_lat, max_lng',
    });
    return;
  }

  const minLat = parseFloat(min_lat as string);
  const minLng = parseFloat(min_lng as string);
  const maxLat = parseFloat(max_lat as string);
  const maxLng = parseFloat(max_lng as string);

  if ([minLat, minLng, maxLat, maxLng].some(isNaN)) {
    res.status(400).json({ error: 'All bounding box parameters must be valid numbers.' });
    return;
  }

  try {
    const result = await pool.query(
      `
      SELECT
        n.id,
        n.tier,
        n.custodian_id,
        n.expires_at_yellow,
        n.expires_at_red,
        ST_Y(n.geom) AS latitude,
        ST_X(n.geom) AS longitude,
        CASE
          WHEN n.expires_at_red   IS NOT NULL AND NOW() > n.expires_at_red   THEN 'red'
          WHEN n.expires_at_yellow IS NOT NULL AND NOW() > n.expires_at_yellow THEN 'yellow'
          ELSE 'green'
        END AS health_state
      FROM nodes n
      WHERE n.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ORDER BY n.id
      `,
      [minLng, minLat, maxLng, maxLat]
    );

    res.json({ nodes: result.rows });
  } catch (err) {
    console.error('Error querying nodes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
